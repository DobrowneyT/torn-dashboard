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
    SHEET_ITEM_OUTCOMES = "item_outcomes"
    
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
    
    def write_weekly_analysis(self, payout_results: List[Dict], from_date: str, to_date: str) -> None:
        """
        Write weekly analysis data with VLOOKUP for member names
        
        Headers: Member ID | Name | Tier | Time (hours) | Base Tickets | 
                Time Penalty | Adjusted Tickets | Crimes Participated | Payout
        """
        logger = logging.getLogger(__name__)
        logger.info("Writing Weekly_Analysis sheet...")
        
        # Clear old data (keep headers in row 1)
        self.SHEET_WEEKLY_ANALYSIS.batch_clear(['A2:I500'])
        
        # Prepare data rows
        rows = []
        for i, member in enumerate(payout_results, start=2):
            member_id = member['member_id']
            
            # Row: [ID, VLOOKUP_FORMULA, Tier, Hours, Base, Penalty, Adjusted, Crimes, Payout]
            row = [
                member_id,
                f'=IFERROR(VLOOKUP(A{i},Members!$A:$B,2,FALSE),"Unknown")',  # VLOOKUP for name
                member['tier'],
                round(member['time_in_crimes'] / 3600, 2),  # Convert seconds to hours
                member['base_tickets'],
                round(member['time_penalty'], 2),
                round(member['adjusted_tickets'], 2),
                member['crimes_participated'],
                f"${member['payout']:,.0f}"
            ]
            rows.append(row)
        
        # Write data
        if rows:
            cell_range = f'A2:I{len(rows) + 1}'
            self.SHEET_WEEKLY_ANALYSIS.update(cell_range, rows, value_input_option='USER_ENTERED')  # USER_ENTERED to process formulas
            logger.info(f"Wrote {len(rows)} rows to Weekly_Analysis")
        
        # Update header with date range
        self.SHEET_WEEKLY_ANALYSIS.update('A1', [[f'Weekly Analysis: {from_date} to {to_date}']])

        logger.info("✓ Weekly_Analysis updated")
    
    # ==================== Payout Operations ====================
    
    def write_payout_calculator(self, payout_results: List[Dict], from_date: str, to_date: str) -> None:
        """
        Write payout calculator data with VLOOKUP for member names
        
        Headers: Member ID | Name | Adjusted Tickets | Payout | Manual Override | Final Payout
        """
        logger = logging.getLogger(__name__)
        logger.info("Writing Payout_Calculator sheet...")
        
        # Clear old data (keep headers in row 1, preserve manual overrides if they exist)
        # Only clear columns A-D, leave E-F for manual overrides and final payout formulas
        self.SHEET_PAYOUT.batch_clear(['A2:D500'])
        
        # Prepare data rows
        rows = []
        for i, member in enumerate(payout_results, start=2):
            member_id = member['member_id']
            
            # Row: [ID, VLOOKUP_FORMULA, Adjusted Tickets, Payout]
            row = [
                member_id,
                f'=IFERROR(VLOOKUP(A{i},Members!$A:$B,2,FALSE),"Unknown")',  # VLOOKUP for name
                round(member['adjusted_tickets'], 2),
                member['payout']
            ]
            rows.append(row)
        
        # Write data
        if rows:
            cell_range = f'A2:D{len(rows) + 1}'
            self.SHEET_PAYOUT.update(cell_range, rows, value_input_option='USER_ENTERED')
            
            # Add Final Payout formulas in column F (if they don't already exist)
            # Formula: =IF(E2="",D2,E2) - use override if present, otherwise use calculated
            final_formulas = []
            for i in range(2, len(rows) + 2):
                final_formulas.append([f'=IF(E{i}="",D{i},E{i})'])
            
            formula_range = f'F2:F{len(rows) + 1}'
            self.SHEET_PAYOUT.update(formula_range, final_formulas, value_input_option='USER_ENTERED')
            
            logger.info(f"Wrote {len(rows)} rows to Payout_Calculator")
        
        # Update header with date range
        self.SHEET_PAYOUT.update('A1', [[f'Payout Calculator: {from_date} to {to_date}']])
        
        # Add totals row
        last_data_row = len(rows) + 1
        totals_row = last_data_row + 2
        
        totals = [
            ['TOTALS:', '', 
            f'=SUM(C2:C{last_data_row})',  # Total adjusted tickets
            f'=SUM(D2:D{last_data_row})',  # Total calculated payout
            '',
            f'=SUM(F2:F{last_data_row})'   # Total final payout
            ]
        ]
        self.SHEET_PAYOUT.update(f'A{totals_row}:F{totals_row}', totals, value_input_option='USER_ENTERED')
        
        logger.info("✓ Payout_Calculator updated")
        
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

    def write_item_outcomes(self, item_details: List[Dict], from_date: str, to_date: str) -> None:
        """
        Write item outcomes (no member names here, but keeping consistent format)
        
        Headers: ID | Name | Status | Market Value | Quantity | Total Value
        """
        logger = logging.getLogger(__name__)
        logger.info("Writing item_outcomes sheet...")
        
        # Clear old data
        self.SHEET_ITEM_OUTCOMES.batch_clear(['A2:F500'])
        
        # Prepare rows
        rows = []
        for item in item_details:
            # Determine if this is a reward (+) or used (-)
            multiplier = 1 if item['status'] == 'reward' else -1
            
            row = [
                item['id'],
                item['name'],
                item['status'],
                item['market_value'],
                item['quantity'],
                multiplier * item['market_value'] * item['quantity']  # Calculate total
            ]
            rows.append(row)
        
        # Write data
        if rows:
            cell_range = f'A2:F{len(rows) + 1}'
            self.SHEET_ITEM_OUTCOMES.update(cell_range, rows, value_input_option='RAW')
            logger.info(f"Wrote {len(rows)} items to item_outcomes")
        
        # Update header with date range
        self.SHEET_ITEM_OUTCOMES.update('A1', [[f'Item Outcomes: {from_date} to {to_date}']])

        # Add summary calculations
        last_data_row = len(rows) + 1
        summary_start = last_data_row + 2
        
        summaries = [
            ['NET TOTAL:', '', '', '', '', f'=SUM(F2:F{last_data_row})'],
            ['REWARDS TOTAL:', '', '', '', '', f'=SUMIF(C2:C{last_data_row},"reward",F2:F{last_data_row})'],
            ['USED TOTAL:', '', '', '', '', f'=SUMIF(C2:C{last_data_row},"used",F2:F{last_data_row})']
        ]
        
        summary_range = f'A{summary_start}:F{summary_start + 2}'
        self.SHEET_ITEM_OUTCOMES.update(summary_range, summaries, value_input_option='USER_ENTERED')
        
        logger.info("✓ item_outcomes updated")
    
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
        
    """
    Member sync function to keep Members sheet up to date
    """

    def sync_faction_members(self, api_key: str) -> None:
        """
        Sync faction members to Members sheet
        Fetches current faction members and updates IDs and names
        
        Args:
            api_key: Torn API key for faction members endpoint
        """
        logger = logging.getLogger(__name__)
        logger.info("Syncing faction members...")
        
        try:
            # Import here to avoid circular imports
            from scripts.utils.torn_api import TornAPI
            
            # Initialize API wrapper
            api = TornAPI(api_key)
            
            # Fetch faction members using API wrapper
            logger.debug("Fetching members from Torn API...")
            response = api.get_faction_members()
            
            # Extract members list from response
            if 'error' in response:
                logger.error(f"API error: {response['error']}")
                raise Exception(f"Torn API error: {response['error']}")
            
            members_list = response.get('members', [])
            
            if not members_list:
                logger.warning("No members returned from API")
                return
            
            # Convert list to rows: [id, name]
            member_rows = []
            for member in members_list:
                member_id = member.get('id')
                member_name = member.get('name', 'Unknown')
                
                if member_id:
                    member_rows.append([
                        int(member_id),
                        member_name
                    ])
            
            # Sort by ID for consistency
            member_rows.sort(key=lambda x: x[0])
            
            logger.info(f"Fetched {len(member_rows)} faction members")
            
            # Clear existing data (starting from row 2, preserve headers)
            self.SHEET_MEMBERS.batch_clear(['A2:B201'])
            
            # Write new member data
            if member_rows:
                cell_range = f'A2:B{len(member_rows) + 1}'
                self.SHEET_MEMBERS.update(cell_range, member_rows, value_input_option='RAW')
                logger.info(f"Updated Members sheet with {len(member_rows)} members")
            
            logger.info("✓ Faction members synced successfully")
            
        except Exception as e:
            logger.error(f"Error syncing members: {e}")
            raise
    
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