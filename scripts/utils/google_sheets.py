"""
Google Sheets utilities for OC management system
Handles all interactions with the Google Sheets dashboard
"""

import os
import logging
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class GoogleSheetsError(Exception):
    """Custom exception for Google Sheets errors"""
    pass


class GoogleSheetsManager:
    """Manage Google Sheets operations for OC system"""
    
    SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
    
    # Sheet names
    SHEET_DASHBOARD = "Dashboard"
    SHEET_WEEKLY_ANALYSIS = "Weekly_Analysis"
    SHEET_PAYOUT = "Payout_Calculator"
    SHEET_CONFIG = "Config"
    SHEET_MEMBERS = "Members"
    
    def __init__(self, credentials_file: str = 'google_credentials.json', spreadsheet_id: Optional[str] = None):
        """
        Initialize Google Sheets manager
        
        Args:
            credentials_file: Path to service account credentials JSON
            spreadsheet_id: Google Sheets spreadsheet ID
        """
        self.credentials_file = credentials_file
        self.spreadsheet_id = spreadsheet_id or os.environ.get('GOOGLE_SHEETS_ID')
        
        if not self.spreadsheet_id:
            raise ValueError("spreadsheet_id must be provided or set in GOOGLE_SHEETS_ID environment variable")
        
        self.service = self._authenticate()
        logger.info(f"Initialized Google Sheets manager for spreadsheet: {self.spreadsheet_id}")
    
    def _authenticate(self):
        """Authenticate with Google Sheets API"""
        try:
            credentials = service_account.Credentials.from_service_account_file(
                self.credentials_file,
                scopes=self.SCOPES
            )
            service = build('sheets', 'v4', credentials=credentials)
            logger.info("Successfully authenticated with Google Sheets")
            return service
            
        except Exception as e:
            logger.error(f"Failed to authenticate with Google Sheets: {e}")
            raise GoogleSheetsError(f"Authentication failed: {e}")
    
    def _get_range_notation(self, sheet_name: str, range_str: str) -> str:
        """
        Get A1 notation for a range
        
        Args:
            sheet_name: Name of the sheet
            range_str: Range in A1 notation (e.g., "A1:B10")
            
        Returns:
            Full range notation (e.g., "Dashboard!A1:B10")
        """
        return f"{sheet_name}!{range_str}"
    
    def read_range(self, sheet_name: str, range_str: str) -> List[List[Any]]:
        """
        Read values from a range
        
        Args:
            sheet_name: Name of the sheet
            range_str: Range in A1 notation
            
        Returns:
            List of rows, each row is a list of values
        """
        try:
            range_notation = self._get_range_notation(sheet_name, range_str)
            result = self.service.spreadsheets().values().get(
                spreadsheetId=self.spreadsheet_id,
                range=range_notation
            ).execute()
            
            values = result.get('values', [])
            logger.info(f"Read {len(values)} rows from {range_notation}")
            return values
            
        except HttpError as e:
            logger.error(f"Error reading range {range_notation}: {e}")
            raise GoogleSheetsError(f"Failed to read range: {e}")
    
    def write_range(self, sheet_name: str, range_str: str, values: List[List[Any]], 
                    value_input_option: str = 'USER_ENTERED') -> bool:
        """
        Write values to a range
        
        Args:
            sheet_name: Name of the sheet
            range_str: Range in A1 notation
            values: 2D array of values to write
            value_input_option: How to interpret input ('RAW' or 'USER_ENTERED')
            
        Returns:
            True if successful
        """
        try:
            range_notation = self._get_range_notation(sheet_name, range_str)
            body = {'values': values}
            
            result = self.service.spreadsheets().values().update(
                spreadsheetId=self.spreadsheet_id,
                range=range_notation,
                valueInputOption=value_input_option,
                body=body
            ).execute()
            
            updated_cells = result.get('updatedCells', 0)
            logger.info(f"Updated {updated_cells} cells in {range_notation}")
            return True
            
        except HttpError as e:
            logger.error(f"Error writing to range {range_notation}: {e}")
            raise GoogleSheetsError(f"Failed to write range: {e}")
    
    def append_rows(self, sheet_name: str, values: List[List[Any]], 
                    value_input_option: str = 'USER_ENTERED') -> bool:
        """
        Append rows to the end of a sheet
        
        Args:
            sheet_name: Name of the sheet
            values: 2D array of values to append
            value_input_option: How to interpret input
            
        Returns:
            True if successful
        """
        try:
            body = {'values': values}
            
            result = self.service.spreadsheets().values().append(
                spreadsheetId=self.spreadsheet_id,
                range=sheet_name,
                valueInputOption=value_input_option,
                insertDataOption='INSERT_ROWS',
                body=body
            ).execute()
            
            updated_rows = result.get('updates', {}).get('updatedRows', 0)
            logger.info(f"Appended {updated_rows} rows to {sheet_name}")
            return True
            
        except HttpError as e:
            logger.error(f"Error appending to {sheet_name}: {e}")
            raise GoogleSheetsError(f"Failed to append rows: {e}")
    
    def clear_range(self, sheet_name: str, range_str: str) -> bool:
        """
        Clear values in a range
        
        Args:
            sheet_name: Name of the sheet
            range_str: Range in A1 notation
            
        Returns:
            True if successful
        """
        try:
            range_notation = self._get_range_notation(sheet_name, range_str)
            
            self.service.spreadsheets().values().clear(
                spreadsheetId=self.spreadsheet_id,
                range=range_notation,
                body={}
            ).execute()
            
            logger.info(f"Cleared range {range_notation}")
            return True
            
        except HttpError as e:
            logger.error(f"Error clearing range {range_notation}: {e}")
            raise GoogleSheetsError(f"Failed to clear range: {e}")
    
    def read_cell(self, sheet_name: str, cell: str) -> Any:
        """
        Read a single cell value
        
        Args:
            sheet_name: Name of the sheet
            cell: Cell in A1 notation (e.g., "B10")
            
        Returns:
            Cell value or None if empty
        """
        values = self.read_range(sheet_name, cell)
        if values and values[0]:
            return values[0][0]
        return None
    
    def write_cell(self, sheet_name: str, cell: str, value: Any) -> bool:
        """
        Write to a single cell
        
        Args:
            sheet_name: Name of the sheet
            cell: Cell in A1 notation
            value: Value to write
            
        Returns:
            True if successful
        """
        return self.write_range(sheet_name, cell, [[value]])
    
    # ==================== Dashboard Operations ====================
    
    def update_dashboard_stats(self, stats: Dict[str, Any]) -> bool:
        """
        Update dashboard statistics
        
        Args:
            stats: Dictionary containing dashboard metrics
                - total_crimes: Total crimes in database
                - pending_crimes: Number of pending crimes
                - completed_this_week: Crimes completed this week
                - active_members: Number of active members
                - last_update: Timestamp of last update
                
        Returns:
            True if successful
        """
        try:
            # Prepare data rows
            values = [
                ["Last Updated", datetime.now().strftime("%Y-%m-%d %H:%M:%S")],
                ["Total Crimes", stats.get('total_crimes', 0)],
                ["Pending Crimes", stats.get('pending_crimes', 0)],
                ["Completed This Week", stats.get('completed_this_week', 0)],
                ["Active Members", stats.get('active_members', 0)],
            ]
            
            self.write_range(self.SHEET_DASHBOARD, "A2:B6", values)
            logger.info("Updated dashboard statistics")
            return True
            
        except Exception as e:
            logger.error(f"Error updating dashboard: {e}")
            raise GoogleSheetsError(f"Failed to update dashboard: {e}")
    
    def update_dashboard_pending_crimes(self, crimes: List[Dict]) -> bool:
        """
        Update pending crimes list on dashboard
        
        Args:
            crimes: List of pending crime dictionaries
            
        Returns:
            True if successful
        """
        try:
            # Clear existing data
            self.clear_range(self.SHEET_DASHBOARD, "A21:F100")
            
            # Write headers
            headers = [["Crime ID", "Name", "Difficulty", "Status", "Slots", "Created"]]
            self.write_range(self.SHEET_DASHBOARD, "A21:F21", headers)
            
            # Prepare crime data
            crime_rows = []
            for crime in crimes[:50]:  # Limit to 50 most recent
                crime_rows.append([
                    crime.get('id', ''),
                    crime.get('name', ''),
                    crime.get('difficulty', ''),
                    crime.get('status', ''),
                    f"{len(crime.get('participants', []))}/{crime.get('slots', 0)}",
                    datetime.fromtimestamp(crime.get('created_at', 0)).strftime("%Y-%m-%d %H:%M")
                ])
            
            if crime_rows:
                self.write_range(self.SHEET_DASHBOARD, "A11:F" + str(10 + len(crime_rows)), crime_rows)
            
            logger.info(f"Updated dashboard with {len(crime_rows)} pending crimes")
            return True
            
        except Exception as e:
            logger.error(f"Error updating pending crimes: {e}")
            raise GoogleSheetsError(f"Failed to update pending crimes: {e}")
    
    # ==================== Config Operations ====================
    
    def read_config(self) -> Dict[str, Any]:
        """
        Read configuration values from Config sheet
        
        Returns:
            Dictionary with config values
        """
        try:
            # Read config key-value pairs (assuming A:B format)
            values = self.read_range(self.SHEET_CONFIG, "A2:B50")
            
            config = {}
            for row in values:
                if len(row) >= 2:
                    key = row[0]
                    value = row[1]
                    config[key] = value
            
            logger.info(f"Read {len(config)} config values")
            return config
            
        except Exception as e:
            logger.error(f"Error reading config: {e}")
            raise GoogleSheetsError(f"Failed to read config: {e}")
    
    def update_config_value(self, key: str, value: Any) -> bool:
        """
        Update a single config value
        
        Args:
            key: Config key
            value: New value
            
        Returns:
            True if successful
        """
        try:
            # Read all config to find the row
            values = self.read_range(self.SHEET_CONFIG, "A2:B50")
            
            row_num = None
            for i, row in enumerate(values):
                if row and row[0] == key:
                    row_num = i + 2  # +2 because we start at row 2
                    break
            
            if row_num:
                self.write_cell(self.SHEET_CONFIG, f"B{row_num}", value)
                logger.info(f"Updated config {key} = {value}")
                return True
            else:
                logger.warning(f"Config key {key} not found")
                return False
                
        except Exception as e:
            logger.error(f"Error updating config: {e}")
            raise GoogleSheetsError(f"Failed to update config: {e}")
    
    def update_status(self, status: str, cell: str = "B10") -> bool:
        """
        Update status cell (typically used for CPR scraper status)
        
        Args:
            status: Status message
            cell: Cell to update (default: B10 in Config sheet)
            
        Returns:
            True if successful
        """
        return self.write_cell(self.SHEET_CONFIG, cell, status)
    
    # ==================== Members Operations ====================
    
    def read_members(self) -> List[Dict]:
        """
        Read member roster from Members sheet
        
        Returns:
            List of member dictionaries
        """
        try:
            values = self.read_range(self.SHEET_MEMBERS, "A2:Z100")
            
            if not values:
                return []
            
            # Assume first row is headers
            headers = ["member_id", "name", "tier", "cpr", "status"]
            
            members = []
            for row in values:
                if not row or not row[0]:  # Skip empty rows
                    continue
                
                member = {}
                for i, header in enumerate(headers):
                    member[header] = row[i] if i < len(row) else None
                
                members.append(member)
            
            logger.info(f"Read {len(members)} members")
            return members
            
        except Exception as e:
            logger.error(f"Error reading members: {e}")
            raise GoogleSheetsError(f"Failed to read members: {e}")
    
    def update_members(self, members: List[Dict]) -> bool:
        """
        Update member roster
        
        Args:
            members: List of member dictionaries with keys:
                - member_id: Torn ID
                - name: Member name
                - tier: Member tier
                - cpr: CPR value
                - status: Active/Inactive
                
        Returns:
            True if successful
        """
        try:
            # Clear existing data
            self.clear_range(self.SHEET_MEMBERS, "A2:E100")
            
            # Prepare member data
            member_rows = []
            for member in members:
                member_rows.append([
                    member.get('member_id', ''),
                    member.get('name', ''),
                    member.get('tier', ''),
                    member.get('cpr', ''),
                    member.get('status', 'Active')
                ])
            
            if member_rows:
                self.write_range(self.SHEET_MEMBERS, "A2:E" + str(1 + len(member_rows)), member_rows)
            
            logger.info(f"Updated {len(member_rows)} members")
            return True
            
        except Exception as e:
            logger.error(f"Error updating members: {e}")
            raise GoogleSheetsError(f"Failed to update members: {e}")
    
    # ==================== Weekly Analysis Operations ====================
    
    def write_weekly_analysis(self, analysis_data: List[Dict], period_start: str, period_end: str) -> bool:
        """
        Write weekly analysis data for payout period
        
        Args:
            analysis_data: List of member analysis dictionaries
            period_start: Start date string
            period_end: End date string
            
        Returns:
            True if successful
        """
        try:
            # Clear existing data
            self.clear_range(self.SHEET_WEEKLY_ANALYSIS, "A1:Z1000")
            
            # Write header with period
            header_info = [[f"Weekly Analysis: {period_start} to {period_end}"]]
            self.write_range(self.SHEET_WEEKLY_ANALYSIS, "A1:A1", header_info)
            
            # Write column headers
            headers = [["Member ID", "Name", "Tier", "Total Time (hrs)", "Tier Multiplier", "Weighted Time", "Crimes Participated"]]
            self.write_range(self.SHEET_WEEKLY_ANALYSIS, "A3:G3", headers)
            
            # Prepare analysis rows
            analysis_rows = []
            for member in analysis_data:
                analysis_rows.append([
                    member.get('member_id', ''),
                    member.get('name', ''),
                    member.get('tier', ''),
                    round(member.get('total_time_hours', 0), 2),
                    member.get('tier_multiplier', 1.0),
                    round(member.get('weighted_time', 0), 2),
                    member.get('crime_count', 0)
                ])
            
            if analysis_rows:
                self.write_range(self.SHEET_WEEKLY_ANALYSIS, "A4:G" + str(3 + len(analysis_rows)), analysis_rows)
            
            logger.info(f"Wrote weekly analysis for {len(analysis_rows)} members")
            return True
            
        except Exception as e:
            logger.error(f"Error writing weekly analysis: {e}")
            raise GoogleSheetsError(f"Failed to write weekly analysis: {e}")
    
    # ==================== Payout Operations ====================
    
    def write_payout_data(self, payout_data: List[Dict], period_start: str, period_end: str) -> bool:
        """
        Write payout calculations
        
        Args:
            payout_data: List of member payout dictionaries
            period_start: Start date string
            period_end: End date string
            
        Returns:
            True if successful
        """
        try:
            # Clear existing data
            self.clear_range(self.SHEET_PAYOUT, "A1:Z1000")
            
            # Write header with period
            header_info = [[f"Payout Calculator: {period_start} to {period_end}"]]
            self.write_range(self.SHEET_PAYOUT, "A1:A1", header_info)
            
            # Write column headers
            headers = [["Member ID", "Name", "Weighted Time", "Rate per Hour", "Calculated Payout", "Manual Override", "Final Payout"]]
            self.write_range(self.SHEET_PAYOUT, "A3:G3", headers)
            
            # Prepare payout rows
            payout_rows = []
            for member in payout_data:
                calculated = member.get('calculated_payout', 0)
                payout_rows.append([
                    member.get('member_id', ''),
                    member.get('name', ''),
                    round(member.get('weighted_time', 0), 2),
                    member.get('rate_per_hour', 0),
                    calculated,
                    '',  # Empty for manual override
                    f'=IF(F{len(payout_rows) + 4}="",E{len(payout_rows) + 4},F{len(payout_rows) + 4})'  # Formula for final
                ])
            
            if payout_rows:
                self.write_range(self.SHEET_PAYOUT, "A4:G" + str(3 + len(payout_rows)), payout_rows)
            
            # Add total row
            total_row_num = 4 + len(payout_rows)
            total_row = [["", "TOTAL", "", "", f"=SUM(E4:E{total_row_num-1})", "", f"=SUM(G4:G{total_row_num-1})"]]
            self.write_range(self.SHEET_PAYOUT, f"A{total_row_num}:G{total_row_num}", total_row)
            
            logger.info(f"Wrote payout data for {len(payout_rows)} members")
            return True
            
        except Exception as e:
            logger.error(f"Error writing payout data: {e}")
            raise GoogleSheetsError(f"Failed to write payout data: {e}")
        
    def read_payout_timestamps(self) -> tuple:
        """
        Read payout analysis timestamps from Dashboard sheet
        
        Returns:
            Tuple of (from_timestamp, to_timestamp) or (None, None) if not set
        
        📍 TO CHANGE CELL LOCATIONS: Modify F2 and F3 below
        """
        try:
            # 📍 CELL LOCATIONS - Change here if Dashboard layout changes
            from_ts = self.read_cell(self.SHEET_DASHBOARD, "F2")  # ⭐ FROM_TIMESTAMP cell
            to_ts = self.read_cell(self.SHEET_DASHBOARD, "F3")    # ⭐ TO_TIMESTAMP cell
            
            if from_ts and to_ts:
                # Convert to int if they're strings
                from_ts = int(float(from_ts)) if from_ts else None
                to_ts = int(float(to_ts)) if to_ts else None
                
                logger.info(f"Read timestamps from Dashboard: {from_ts} to {to_ts}")
                return from_ts, to_ts
            else:
                logger.warning("Timestamps not set in Dashboard F2:F3")
                return None, None
                
        except Exception as e:
            logger.error(f"Error reading timestamps from Dashboard: {e}")
            return None, None

    def write_payout_summary(self, income: Dict, member_count: int) -> bool:
        """
        Write payout summary to Dashboard sheet
        
        Args:
            income: Income calculation dict from calculate_net_income()
            member_count: Number of participating members
            
        Returns:
            True if successful
        
        📍 TO CHANGE CELL LOCATIONS: Modify E5:E11 range below
        """
        try:
            # Calculate pooled payout per member
            pooled_per_member = income['net_pool'] / member_count if member_count > 0 else 0
            
            # 📍 CELL LOCATIONS - Change here if Dashboard layout changes
            # Writing to cells E6:E12 (column E, rows 6-12)
            summary_data = [
                ["20.00%"],            # E6  - Faction cut
                [income['gross_rewards']],        # E7  - Money Reward
                [income['item_rewards_value']],   # E8  - Item Reward
                [income['item_used_value']],      # E9  - Item Cost
                [income['net_pool']],             # E10 - Member payout
                [member_count],                   # E11 - Participating members
                [pooled_per_member]               # E12 - Pooled payout per member
            ]

            self.write_range(self.SHEET_DASHBOARD, "E6:E12", summary_data)

            logger.info(f"Wrote payout summary to Dashboard")
            logger.info(f"  Net pool: ${income['net_pool']:,}")
            logger.info(f"  Members: {member_count}")
            logger.info(f"  Per member average: ${pooled_per_member:,.0f}")
            
            return True
            
        except Exception as e:
            logger.error(f"Error writing payout summary: {e}")
            raise GoogleSheetsError(f"Failed to write payout summary: {e}")

    def write_item_outcomes(self, item_details: List[Dict], period_start: str, period_end: str) -> bool:
        """
        Write item outcomes (rewards vs used) to item_outcomes sheet
        
        Args:
            item_details: List of item dicts with id, name, status, market_value, quantity, total_value
            period_start: Start date string
            period_end: End date string
            
        Returns:
            True if successful
        """
        try:
            # Clear existing data
            self.clear_range('item_outcomes', "A1:Z1000")
            
            # Write headers
            headers = [["ID", "Name", "Status", "Market Value", "Quantity", "Total Value"]]
            self.write_range('item_outcomes', "A1:F1", headers)
            
            if not item_details:
                logger.info("No items to write")
                return True
            
            # Sort by status (rewards first, then used)
            item_details.sort(key=lambda x: (x['status'] != 'reward', x['name']))
            
            # Prepare rows with formulas
            item_rows = []
            for i, item in enumerate(item_details, start=2):
                # Create formula for total value
                if item['status'] == 'reward':
                    total_formula = f"=D{i}*E{i}"
                else:  # used
                    total_formula = f"=-D{i}*E{i}"
                
                item_rows.append([
                    item['id'],
                    item['name'],
                    item['status'],
                    item['market_value'],
                    item['quantity'],
                    total_formula
                ])
            
            # Write item rows
            if item_rows:
                self.write_range('item_outcomes', f"A2:F{len(item_rows)+1}", item_rows)
            
            # Add summary calculations
            summary_row = len(item_rows) + 3
            
            summary_data = [
                [f"NET TOTAL:", "", "", "", "", f"=SUM(F2:F{len(item_rows)+1})"],
                [f"REWARDS TOTAL:", "", "", "", "", f'=SUMIF(C2:C{len(item_rows)+1},"reward",F2:F{len(item_rows)+1})'],
                [f"USED TOTAL:", "", "", "", "", f'=SUMIF(C2:C{len(item_rows)+1},"used",F2:F{len(item_rows)+1})']
            ]
            
            self.write_range('item_outcomes', f"A{summary_row}:F{summary_row+2}", summary_data)
            
            # Also write fixed cell references (H1:H3) for easy access
            self.write_cell('item_outcomes', 'G1', 'Net Total:')
            self.write_cell('item_outcomes', 'H1', f"=SUM(F2:F{len(item_rows)+1})")
            
            self.write_cell('item_outcomes', 'G2', 'Rewards Total:')
            self.write_cell('item_outcomes', 'H2', f'=SUMIF(C2:C{len(item_rows)+1},"reward",F2:F{len(item_rows)+1})')
            
            self.write_cell('item_outcomes', 'G3', 'Used Total:')
            self.write_cell('item_outcomes', 'H3', f'=SUMIF(C2:C{len(item_rows)+1},"used",F2:F{len(item_rows)+1})')
            
            logger.info(f"Wrote {len(item_rows)} item entries to item_outcomes sheet")
            return True
            
        except Exception as e:
            logger.error(f"Error writing item outcomes: {e}")
            raise GoogleSheetsError(f"Failed to write item outcomes: {e}")
    
    # ==================== Crime Log Operations ====================
    
    def write_crime_log(self, crime_rows: List[List[Any]]) -> bool:
        """
        Write crime log data to Crime_Log sheet
        
        Args:
            crime_rows: List of crime data rows
                Each row: [id, name, difficulty, status, slots, created, executed, participants]
                
        Returns:
            True if successful
        """
        try:
            # Clear existing data
            self.clear_range("Crime_Log", "A2:H10000")
            
            # Write headers
            headers = [[
                "Crime ID",
                "Crime Name",
                "Difficulty",
                "Status",
                "Slots Filled",
                "Created At",
                "Executed At",
                "Participants"
            ]]
            self.write_range("Crime_Log", "A1:H1", headers)
            
            # Write crime data
            if crime_rows:
                end_row = 1 + len(crime_rows)
                self.write_range("Crime_Log", f"A2:H{end_row}", crime_rows)
            
            logger.info(f"Wrote {len(crime_rows)} crimes to Crime_Log sheet")
            return True
            
        except Exception as e:
            logger.error(f"Error writing crime log: {e}")
            raise GoogleSheetsError(f"Failed to write crime log: {e}")
    
    # ==================== Utility Methods ====================
    
    def get_sheet_properties(self) -> Dict:
        """
        Get spreadsheet properties
        
        Returns:
            Dictionary with spreadsheet metadata
        """
        try:
            sheet_metadata = self.service.spreadsheets().get(
                spreadsheetId=self.spreadsheet_id
            ).execute()
            
            return sheet_metadata
            
        except HttpError as e:
            logger.error(f"Error getting sheet properties: {e}")
            raise GoogleSheetsError(f"Failed to get properties: {e}")
    
    def test_connection(self) -> bool:
        """
        Test connection to spreadsheet
        
        Returns:
            True if successful
        """
        try:
            self.get_sheet_properties()
            logger.info("Successfully connected to spreadsheet")
            return True
            
        except Exception as e:
            logger.error(f"Connection test failed: {e}")
            return False


# Convenience function for scripts
def create_sheets_manager(credentials_file: str = 'google_credentials.json',
                         spreadsheet_id: Optional[str] = None) -> GoogleSheetsManager:
    """
    Create GoogleSheetsManager instance
    
    Args:
        credentials_file: Path to credentials JSON
        spreadsheet_id: Optional spreadsheet ID
        
    Returns:
        GoogleSheetsManager instance
    """
    return GoogleSheetsManager(credentials_file, spreadsheet_id)


if __name__ == "__main__":
    # Test script
    import os
    
    spreadsheet_id = os.environ.get('GOOGLE_SHEETS_ID')
    
    if not spreadsheet_id:
        print("Error: GOOGLE_SHEETS_ID environment variable not set")
        exit(1)
    
    if not os.path.exists('google_credentials.json'):
        print("Error: google_credentials.json not found")
        exit(1)
    
    print("Testing Google Sheets connection...")
    sheets = GoogleSheetsManager(spreadsheet_id=spreadsheet_id)
    
    if sheets.test_connection():
        print("✓ Connection successful")
        
        # Get sheet properties
        props = sheets.get_sheet_properties()
        print(f"✓ Spreadsheet: {props.get('properties', {}).get('title', 'Unknown')}")
        
        # Test reading config
        print("\nTesting config read...")
        try:
            config = sheets.read_config()
            print(f"✓ Read {len(config)} config values")
        except Exception as e:
            print(f"⚠ Config read failed (sheet may not exist yet): {e}")
        
        # Test status update
        print("\nTesting status update...")
        try:
            sheets.update_status("Test successful at " + datetime.now().strftime("%H:%M:%S"))
            print("✓ Status update successful")
        except Exception as e:
            print(f"⚠ Status update failed: {e}")
    else:
        print("✗ Connection failed")