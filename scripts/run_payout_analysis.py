"""
Main Payout Analysis Script
Orchestrates window analysis, item tracking, and payout calculation
Reads timestamps from Dashboard sheet (B16:B17) or environment variables
"""

import os
import sys
import logging
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.analyze_payout_window import analyze_window
from scripts.calculate_payouts import calculate_payouts, PayoutCalculator
from scripts.utils.google_sheets import GoogleSheetsManager

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def main():
    """Main execution function"""
    logger.info("="*60)
    logger.info("Starting Payout Window Analysis")
    logger.info("="*60)
    
    try:
        # Initialize Google Sheets
        sheets = GoogleSheetsManager()
        
        # Try to read timestamps from Dashboard sheet first
        from_ts, to_ts = sheets.read_payout_timestamps()
        
        # Fall back to environment variables if not set in sheet
        if from_ts is None or to_ts is None:
            logger.info("Timestamps not found in Dashboard, checking environment variables...")
            from_ts = os.environ.get('FROM_TIMESTAMP')
            to_ts = os.environ.get('TO_TIMESTAMP')
            
            if not from_ts or not to_ts:
                error_msg = "Timestamps not found in Dashboard (F2:F3) or environment variables"
                logger.error(error_msg)
                sheets.write_cell('Dashboard', 'E4', f"ERROR: {error_msg}")  # 📍 Status cell
                raise ValueError(error_msg)
            
            from_ts = int(from_ts)
            to_ts = int(to_ts)
            logger.info("Using timestamps from environment variables")
        else:
            logger.info("Using timestamps from Dashboard sheet")
        
        # Get API key
        api_key = os.environ.get('TORN_API_KEY')
        if not api_key:
            raise ValueError("TORN_API_KEY environment variable not set")
        
        # Update status
        sheets.write_cell('Dashboard', 'E4', "Analysis in progress...")  # 📍 Status cell

        # ===== STEP 0: Sync faction members FIRST =====
        logger.info("\nStep 0: Syncing faction members...")
        sheets.sync_faction_members(api_key)
        
        logger.info(f"Analysis window: {from_ts} to {to_ts}")
        from_date = datetime.fromtimestamp(from_ts).strftime('%Y-%m-%d')
        to_date = datetime.fromtimestamp(to_ts).strftime('%Y-%m-%d')
        logger.info(f"Date range: {from_date} to {to_date}")
        logger.info(f"Duration: {(to_ts - from_ts) / 86400:.1f} days")
        
        # ===== STEP 1: Analyze Time Window =====
        logger.info("\n" + "="*60)
        logger.info("STEP 1: Analyzing Crime Window")
        logger.info("="*60)
        
        analysis = analyze_window(from_ts, to_ts)
        
        logger.info(f"Window analysis complete:")
        logger.info(f"  Total crimes: {analysis['crimes']['total']}")
        logger.info(f"  Successful: {analysis['crimes']['successful']}")
        logger.info(f"  Failed: {analysis['crimes']['failed']}")
        logger.info(f"  Total rewards: ${analysis['crimes']['total_rewards']:,}")
        logger.info(f"  Members participated: {len(analysis['members'])}")
        logger.info(f"  Reward items: {len(analysis['items']['rewards'])}")
        logger.info(f"  Used items: {len(analysis['items']['used'])}")
        
        if analysis['crimes']['total'] == 0:
            logger.warning("No crimes found in this window!")
            sheets.write_cell('Dashboard', 'E4', "No crimes in window")  # 📍 Status cell
            logger.info("Please check your timestamp values")
            return
        
        # ===== STEP 2: Fetch Item Market Values =====
        logger.info("\n" + "="*60)
        logger.info("STEP 2: Fetching Item Market Values")
        logger.info("="*60)
        
        # Collect all unique item IDs
        all_item_ids = set()
        for item in analysis['items']['rewards'] + analysis['items']['used']:
            all_item_ids.add(item['id'])
        
        logger.info(f"Found {len(all_item_ids)} unique items")
        
        calculator = PayoutCalculator()
        item_data = calculator.fetch_item_market_values(all_item_ids, api_key)
        
        if len(item_data) < len(all_item_ids):
            logger.warning(f"Could not fetch data for {len(all_item_ids) - len(item_data)} items")
        
        # ===== STEP 3: Calculate Net Income Pool =====
        logger.info("\n" + "="*60)
        logger.info("STEP 3: Calculating Net Income Pool")
        logger.info("="*60)
        
        income = calculator.calculate_net_income(analysis, item_data)
        
        # ===== STEP 4: Calculate Member Payouts =====
        logger.info("\n" + "="*60)
        logger.info("STEP 4: Calculating Member Payouts")
        logger.info("="*60)
        
        payout_results = calculate_payouts(
            analysis['members'],
            income['net_pool'],
            analysis['window']['duration_seconds']
        )
        
        # Sort by payout amount (highest first)
        payout_results.sort(key=lambda x: x['payout'], reverse=True)
        
        logger.info(f"Calculated payouts for {len(payout_results)} members")
        
        # Log top payouts
        logger.info("\nTop 5 payouts:")
        for i, member in enumerate(payout_results[:5], 1):
            logger.info(
                f"  {i}. Member {member['member_id']}: "
                f"${member['payout']:,.0f} "
                f"({member['adjusted_tickets']:.1f} tickets, "
                f"{member['time_in_days']:.1f} days)"
            )
        
        total_distributed = sum(m['payout'] for m in payout_results)
        logger.info(f"\nTotal distributed: ${total_distributed:,.0f}")
        logger.info(f"Net pool: ${income['net_pool']:,.0f}")
        
        if abs(total_distributed - income['net_pool']) > 1:
            logger.warning("Distribution doesn't match pool! Check calculations.")
        
        # ===== STEP 5: Update Google Sheets =====
        logger.info("\n" + "="*60)
        logger.info("STEP 5: Updating Google Sheets")
        logger.info("="*60)
        
        # Write payout summary to Dashboard
        logger.info("Writing payout summary to Dashboard...")
        sheets.write_payout_summary(income, len(payout_results))
        
        # Write weekly analysis
        logger.info("Writing Weekly_Analysis sheet...")
        sheets.write_weekly_analysis(payout_results, from_date, to_date)
        
        # Write payout calculator
        logger.info("Writing Payout_Calculator sheet...")
        sheets.write_payout_data(payout_results, from_date, to_date)
        
        # Write item outcomes
        logger.info("Writing item_outcomes sheet...")
        sheets.write_item_outcomes(income['item_details'], from_date, to_date)
        
        # Update status
        status_message = f"Complete: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} - ${income['net_pool']:,.0f} distributed"
        sheets.write_cell('Dashboard', 'E4', status_message)  # 📍 Status cell
        
        logger.info("\n" + "="*60)
        logger.info("Payout Analysis Completed Successfully!")
        logger.info("="*60)
        logger.info(f"Period: {from_date} to {to_date}")
        logger.info(f"Crimes analyzed: {analysis['crimes']['total']}")
        logger.info(f"Net pool: ${income['net_pool']:,}")
        logger.info(f"Members paid: {len(payout_results)}")
        logger.info("="*60)
        
    except KeyError as e:
        logger.error(f"Missing required parameter: {e}")
        logger.error("Set timestamps in Dashboard F2:F3 or environment variables")  # 📍 Input cells
        try:
            sheets.write_cell('Dashboard', 'E4', f"ERROR: Missing {e}")  # 📍 Status cell
        except:
            pass
        sys.exit(1)
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        import traceback
        traceback.print_exc()
        try:
            sheets.write_cell('Dashboard', 'E4', f"ERROR: {str(e)[:50]}")  # 📍 Status cell
        except:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()