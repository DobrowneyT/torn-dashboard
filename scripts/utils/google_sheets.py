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

try:
    import pandas as pd
    PANDAS_AVAILABLE = True
except ImportError:
    PANDAS_AVAILABLE = False
    logging.warning("pandas not available - DataFrame methods will not work")

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
    SHEET_CRIME_LOG = "Crime_Log"
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
        self._sheet_id_cache = {}  # Cache for sheet IDs
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
    
    def _get_sheet_id(self, sheet_name: str) -> int:
        """
        Get the internal sheet ID for a given sheet name
        Used for batch updates
        
        Args:
            sheet_name: Name of the sheet
            
        Returns:
            Sheet ID (integer)
        """
        # Check cache first
        if sheet_name in self._sheet_id_cache:
            return self._sheet_id_cache[sheet_name]
        
        try:
            metadata = self.service.spreadsheets().get(
                spreadsheetId=self.spreadsheet_id
            ).execute()
            
            for sheet in metadata.get('sheets', []):
                if sheet['properties']['title'] == sheet_name:
                    sheet_id = sheet['properties']['sheetId']
                    self._sheet_id_cache[sheet_name] = sheet_id
                    return sheet_id
            
            raise GoogleSheetsError(f"Sheet '{sheet_name}' not found")
            
        except HttpError as e:
            logger.error(f"Error getting sheet ID for {sheet_name}: {e}")
            raise GoogleSheetsError(f"Failed to get sheet ID: {e}")
    
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
    
    def batch_update(self, requests: List[Dict]) -> bool:
        """
        Execute batch update requests
        
        Args:
            requests: List of update request objects
            
        Returns:
            True if successful
        """
        try:
            body = {'requests': requests}
            
            result = self.service.spreadsheets().batchUpdate(
                spreadsheetId=self.spreadsheet_id,
                body=body
            ).execute()
            
            logger.info(f"Batch update completed: {len(requests)} requests processed")
            return True
            
        except HttpError as e:
            logger.error(f"Error in batch update: {e}")
            raise GoogleSheetsError(f"Failed to batch update: {e}")
    
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
        
    def delete_rows(self, sheet_name: str, start_row: int, end_row: int) -> bool:
        """
        Delete rows from a sheet
        
        Args:
            sheet_name: Name of the sheet
            start_row: Starting row number (1-indexed, inclusive)
            end_row: Ending row number (1-indexed, inclusive)
            
        Returns:
            True if successful
        """
        try:
            sheet_id = self._get_sheet_id(sheet_name)
            
            # Convert to 0-indexed for API (and make end_row exclusive)
            start_index = start_row - 1
            end_index = end_row  # API uses exclusive end
            
            request = {
                'deleteDimension': {
                    'range': {
                        'sheetId': sheet_id,
                        'dimension': 'ROWS',
                        'startIndex': start_index,
                        'endIndex': end_index
                    }
                }
            }
            
            self.batch_update([request])
            logger.info(f"Deleted rows {start_row} to {end_row} from {sheet_name}")
            return True
            
        except Exception as e:
            logger.error(f"Error deleting rows: {e}")
            raise GoogleSheetsError(f"Failed to delete rows: {e}")


    def insert_blank_rows(self, sheet_name: str, start_row: int, num_rows: int) -> bool:
        """
        Insert blank rows into a sheet
        
        Args:
            sheet_name: Name of the sheet
            start_row: Row number to insert before (1-indexed)
            num_rows: Number of rows to insert
            
        Returns:
            True if successful
        """
        try:
            sheet_id = self._get_sheet_id(sheet_name)
            
            # Convert to 0-indexed for API
            start_index = start_row - 1
            end_index = start_index + num_rows
            
            request = {
                'insertDimension': {
                    'range': {
                        'sheetId': sheet_id,
                        'dimension': 'ROWS',
                        'startIndex': start_index,
                        'endIndex': end_index
                    },
                    'inheritFromBefore': False
                }
            }
            
            self.batch_update([request])
            logger.info(f"Inserted {num_rows} blank rows at row {start_row} in {sheet_name}")
            return True
            
        except Exception as e:
            logger.error(f"Error inserting rows: {e}")
            raise GoogleSheetsError(f"Failed to insert rows: {e}")
    
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
    
    # ==================== BATCH UPDATE METHODS ====================
    
    def update_dashboard_stats_batch(self, stats: Dict[str, Any]) -> bool:
        """
        Update dashboard statistics using batch update (more efficient)
        
        Args:
            stats: Dictionary containing dashboard metrics
                - total_crimes: Total crimes in database
                - pending_crimes: Number of pending crimes
                - completed_this_week: Crimes completed this week
                - active_members: Number of active members
                
        Returns:
            True if successful
        """
        try:
            sheet_id = self._get_sheet_id(self.SHEET_DASHBOARD)
            
            # Prepare data rows
            data_rows = [
                [{"userEnteredValue": {"stringValue": "Last Updated"}}, 
                 {"userEnteredValue": {"stringValue": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}}],
                [{"userEnteredValue": {"stringValue": "Total Crimes"}}, 
                 {"userEnteredValue": {"numberValue": stats.get('total_crimes', 0)}}],
                [{"userEnteredValue": {"stringValue": "Pending Crimes"}}, 
                 {"userEnteredValue": {"numberValue": stats.get('pending_crimes', 0)}}],
                [{"userEnteredValue": {"stringValue": "Completed This Week"}}, 
                 {"userEnteredValue": {"numberValue": stats.get('completed_this_week', 0)}}],
                [{"userEnteredValue": {"stringValue": "Active Members"}}, 
                 {"userEnteredValue": {"numberValue": stats.get('active_members', 0)}}],
            ]
            
            requests = [{
                'updateCells': {
                    'range': {
                        'sheetId': sheet_id,
                        'startRowIndex': 1,  # Row 2 (0-indexed)
                        'endRowIndex': 6,    # Row 6
                        'startColumnIndex': 0,  # Column A
                        'endColumnIndex': 2     # Column B
                    },
                    'rows': [{'values': row} for row in data_rows],
                    'fields': 'userEnteredValue'
                }
            }]
            
            self.batch_update(requests)
            logger.info("Updated dashboard statistics (batch)")
            return True
            
        except Exception as e:
            logger.error(f"Error updating dashboard: {e}")
            raise GoogleSheetsError(f"Failed to update dashboard: {e}")
    
    def update_dashboard_pending_crimes_batch(self, crimes: List[Dict]) -> bool:
        """
        Update pending crimes list on dashboard using batch update
        
        Args:
            crimes: List of pending crime dictionaries
            
        Returns:
            True if successful
        """
        try:
            sheet_id = self._get_sheet_id(self.SHEET_DASHBOARD)
            
            # Prepare header row
            header_row = [
                {"userEnteredValue": {"stringValue": "Crime ID"}},
                {"userEnteredValue": {"stringValue": "Name"}},
                {"userEnteredValue": {"stringValue": "Difficulty"}},
                {"userEnteredValue": {"stringValue": "Status"}},
                {"userEnteredValue": {"stringValue": "Slots"}},
                {"userEnteredValue": {"stringValue": "Created"}}
            ]
            
            # Prepare crime data rows
            data_rows = [header_row]
            
            for crime in crimes[:50]:  # Limit to 50
                row = [
                    {"userEnteredValue": {"numberValue": crime.get('id', 0)}},
                    {"userEnteredValue": {"stringValue": crime.get('name', '')}},
                    {"userEnteredValue": {"numberValue": crime.get('difficulty', 0)}},
                    {"userEnteredValue": {"stringValue": crime.get('status', '')}},
                    {"userEnteredValue": {"stringValue": f"{crime.get('filled_slots', 0)}/{crime.get('total_slots', 0)}"}},
                    {"userEnteredValue": {"stringValue": datetime.fromtimestamp(crime.get('created_at', 0)).strftime("%Y-%m-%d %H:%M") if crime.get('created_at') else ''}}
                ]
                data_rows.append(row)
            
            # Calculate range
            end_row = 15 + len(data_rows)  # Start at row 16, add all rows
            
            requests = [
                # Clear the range first
                {
                    'updateCells': {
                        'range': {
                            'sheetId': sheet_id,
                            'startRowIndex': 15,  # Row 16
                            'endRowIndex': 100,   # Clear up to row 100
                            'startColumnIndex': 0,
                            'endColumnIndex': 6
                        },
                        'fields': 'userEnteredValue'
                    }
                },
                # Write new data
                {
                    'updateCells': {
                        'range': {
                            'sheetId': sheet_id,
                            'startRowIndex': 15,  # Row 16
                            'endRowIndex': end_row,
                            'startColumnIndex': 0,  # Column A
                            'endColumnIndex': 6     # Column F
                        },
                        'rows': [{'values': row} for row in data_rows],
                        'fields': 'userEnteredValue'
                    }
                }
            ]
            
            self.batch_update(requests)
            logger.info(f"Updated dashboard with {len(crimes)} pending crimes (batch)")
            return True
            
        except Exception as e:
            logger.error(f"Error updating pending crimes: {e}")
            raise GoogleSheetsError(f"Failed to update pending crimes: {e}")
    
    def write_crime_log_batch(self, crime_rows: List[List[Any]]) -> bool:
        """
        Write crime log data to Crime_Log sheet using batch update
        
        Args:
            crime_rows: List of crime data rows
                Each row: [id, name, difficulty, status, slots, created, executed, participants]
                
        Returns:
            True if successful
        """
        try:
            sheet_id = self._get_sheet_id(self.SHEET_CRIME_LOG)
            
            # Prepare header
            header = [
                {"userEnteredValue": {"stringValue": "Crime ID"}},
                {"userEnteredValue": {"stringValue": "Crime Name"}},
                {"userEnteredValue": {"stringValue": "Difficulty"}},
                {"userEnteredValue": {"stringValue": "Status"}},
                {"userEnteredValue": {"stringValue": "Slots Filled"}},
                {"userEnteredValue": {"stringValue": "Created At"}},
                {"userEnteredValue": {"stringValue": "Executed At"}},
                {"userEnteredValue": {"stringValue": "Participants"}}
            ]
            
            # Convert crime rows to cell format
            formatted_rows = [header]
            for row in crime_rows:
                formatted_row = []
                for i, cell in enumerate(row):
                    if i in [0, 2]:  # Crime ID and Difficulty are numbers
                        formatted_row.append({"userEnteredValue": {"numberValue": cell if cell else 0}})
                    else:
                        formatted_row.append({"userEnteredValue": {"stringValue": str(cell) if cell else ''}})
                formatted_rows.append(formatted_row)
            
            end_row = len(formatted_rows)
            
            requests = [
                # Clear existing data
                {
                    'updateCells': {
                        'range': {
                            'sheetId': sheet_id,
                            'startRowIndex': 0,
                            'endRowIndex': 10000,
                            'startColumnIndex': 0,
                            'endColumnIndex': 8
                        },
                        'fields': 'userEnteredValue'
                    }
                },
                # Write new data
                {
                    'updateCells': {
                        'range': {
                            'sheetId': sheet_id,
                            'startRowIndex': 0,
                            'endRowIndex': end_row,
                            'startColumnIndex': 0,
                            'endColumnIndex': 8
                        },
                        'rows': [{'values': row} for row in formatted_rows],
                        'fields': 'userEnteredValue'
                    }
                }
            ]
            
            self.batch_update(requests)
            logger.info(f"Wrote {len(crime_rows)} crimes to Crime_Log sheet (batch)")
            return True
            
        except Exception as e:
            logger.error(f"Error writing crime log: {e}")
            raise GoogleSheetsError(f"Failed to write crime log: {e}")
    
    # ==================== PANDAS DATAFRAME METHODS ====================
    
    def write_dataframe_to_sheet(self, df: 'pd.DataFrame', sheet_name: str, 
                                  start_row: int = 1, start_col: int = 1,
                                  include_index: bool = False,
                                  include_headers: bool = False) -> bool:
        """
        Write a pandas DataFrame to a Google Sheet
        
        Args:
            df: pandas DataFrame to write
            sheet_name: Name of the target sheet
            start_row: Starting row (1-indexed)
            start_col: Starting column (1-indexed)
            include_index: Whether to include the DataFrame index
            
        Returns:
            True if successful
        """
        if not PANDAS_AVAILABLE:
            raise GoogleSheetsError("pandas is not installed. Install with: pip install pandas")
        
        try:
            logger.info(f"Writing DataFrame to sheet '{sheet_name}' ({len(df)} rows, {len(df.columns)} columns)")
            
            # CRITICAL: Replace NaN values with empty strings to avoid JSON errors
            df = df.fillna('')
            
            # Convert DataFrame to list of lists
            if include_index:
                # Include index as first column
                headers = ['Index'] + df.columns.tolist()
                data = [[idx] + row.tolist() for idx, row in df.iterrows()]
            else:
                headers = df.columns.tolist()
                data = df.values.tolist()
            
            # Combine headers and data
            if include_headers:
                all_data = [headers] + data
            else:
                all_data = data

            # Clean data to ensure JSON serialization works
            # Convert any remaining problematic values
            cleaned_data = []
            for row in all_data:
                cleaned_row = []
                for cell in row:
                    # Handle special float values
                    if isinstance(cell, float):
                        import math
                        if math.isnan(cell) or math.isinf(cell):
                            cleaned_row.append('')
                        else:
                            cleaned_row.append(cell)
                    # Convert None to empty string
                    elif cell is None:
                        cleaned_row.append('')
                    else:
                        cleaned_row.append(cell)
                cleaned_data.append(cleaned_row)
            
            # Convert to column letters
            def num_to_col(n):
                """Convert column number to letter (1 -> A, 27 -> AA)"""
                result = ""
                while n > 0:
                    n -= 1
                    result = chr(65 + (n % 26)) + result
                    n //= 26
                return result
            
            start_col_letter = num_to_col(start_col)
            end_col_letter = num_to_col(start_col + len(headers) - 1)
            end_row = start_row + len(cleaned_data) - 1
            
            range_str = f"{start_col_letter}{start_row}:{end_col_letter}{end_row}"
            
            logger.info(f"Writing to range: {sheet_name}!{range_str}")
            
            # Write using standard method
            self.write_range(sheet_name, range_str, cleaned_data, value_input_option='RAW')
            
            logger.info(f"✓ Successfully wrote DataFrame to {sheet_name}")
            return True
            
        except Exception as e:
            logger.error(f"Error writing DataFrame to sheet: {e}")
            raise GoogleSheetsError(f"Failed to write DataFrame: {e}")
    
    def read_sheet_to_dataframe(self, sheet_name: str, range_str: Optional[str] = None,
                                header_row: int = 0) -> 'pd.DataFrame':
        """
        Read a Google Sheet range into a pandas DataFrame
        
        Args:
            sheet_name: Name of the sheet
            range_str: Optional range (e.g., "A1:F100"). If None, reads entire sheet
            header_row: Which row contains headers (0-indexed)
            
        Returns:
            pandas DataFrame
        """
        if not PANDAS_AVAILABLE:
            raise GoogleSheetsError("pandas is not installed. Install with: pip install pandas")
        
        try:
            # Read the range
            if range_str:
                values = self.read_range(sheet_name, range_str)
            else:
                values = self.read_range(sheet_name, "A1:ZZ10000")
            
            if not values:
                logger.warning(f"No data found in {sheet_name}")
                return pd.DataFrame()
            
            # Extract headers and data
            if len(values) > header_row:
                headers = values[header_row]
                data = values[header_row + 1:]
            else:
                headers = values[0] if values else []
                data = []
            
            # Create DataFrame
            df = pd.DataFrame(data, columns=headers)
            
            logger.info(f"Read {len(df)} rows from {sheet_name} into DataFrame")
            return df
            
        except Exception as e:
            logger.error(f"Error reading sheet to DataFrame: {e}")
            raise GoogleSheetsError(f"Failed to read DataFrame: {e}")
    
    # ==================== Dashboard Operations (Original) ====================
    
    def update_dashboard_stats(self, stats: Dict[str, Any]) -> bool:
        """
        Update dashboard statistics (standard method - use batch version for efficiency)
        
        Args:
            stats: Dictionary containing dashboard metrics
                
        Returns:
            True if successful
        """
        try:
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
        Update pending crimes list on dashboard (standard method)
        
        Args:
            crimes: List of pending crime dictionaries
            
        Returns:
            True if successful
        """
        try:
            # Clear existing data
            self.clear_range(self.SHEET_DASHBOARD, "A16:F100")
            
            # Write headers
            headers = [["Crime ID", "Name", "Difficulty", "Status", "Slots", "Created"]]
            self.write_range(self.SHEET_DASHBOARD, "A16:F16", headers)
            
            # Prepare crime data
            crime_rows = []
            for crime in crimes[:50]:
                crime_rows.append([
                    crime.get('id', ''),
                    crime.get('name', ''),
                    crime.get('difficulty', ''),
                    crime.get('status', ''),
                    f"{crime.get('filled_slots', 0)}/{crime.get('total_slots', 0)}",
                    datetime.fromtimestamp(crime.get('created_at', 0)).strftime("%Y-%m-%d %H:%M") if crime.get('created_at') else ''
                ])
            
            if crime_rows:
                end_row = 16 + len(crime_rows)
                self.write_range(self.SHEET_DASHBOARD, f"A17:F{end_row}", crime_rows)
            
            logger.info(f"Updated dashboard with {len(crime_rows)} pending crimes")
            return True
            
        except Exception as e:
            logger.error(f"Error updating pending crimes: {e}")
            raise GoogleSheetsError(f"Failed to update pending crimes: {e}")



# import os
# import logging
# from typing import Dict, List, Optional, Any, Tuple
# from datetime import datetime

# from google.oauth2 import service_account
# from googleapiclient.discovery import build
# from googleapiclient.errors import HttpError

# logging.basicConfig(level=logging.INFO)
# logger = logging.getLogger(__name__)


# class GoogleSheetsError(Exception):
#     """Custom exception for Google Sheets errors"""
#     pass


# class GoogleSheetsManager:
#     """Manage Google Sheets operations for OC system"""
    
#     SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
    
#     # Sheet names
#     SHEET_DASHBOARD = "Dashboard"
#     SHEET_CRIME_LOG = "Crime_Log"
#     SHEET_WEEKLY_ANALYSIS = "Weekly_Analysis"
#     SHEET_PAYOUT = "Payout_Calculator"
#     SHEET_CONFIG = "Config"
#     SHEET_MEMBERS = "Members"
#     SHEET_ITEM_OUTCOMES = "item_outcomes"
    
#     def __init__(self, credentials_file: str = 'google_credentials.json', spreadsheet_id: Optional[str] = None):
#         """
#         Initialize Google Sheets manager
        
#         Args:
#             credentials_file: Path to service account credentials JSON
#             spreadsheet_id: Google Sheets spreadsheet ID
#         """
#         self.credentials_file = credentials_file
#         self.spreadsheet_id = spreadsheet_id or os.environ.get('GOOGLE_SHEETS_ID')
        
#         if not self.spreadsheet_id:
#             raise ValueError("spreadsheet_id must be provided or set in GOOGLE_SHEETS_ID environment variable")
        
#         self.service = self._authenticate()
#         logger.info(f"Initialized Google Sheets manager for spreadsheet: {self.spreadsheet_id}")
    
#     def _authenticate(self):
#         """Authenticate with Google Sheets API"""
#         try:
#             credentials = service_account.Credentials.from_service_account_file(
#                 self.credentials_file,
#                 scopes=self.SCOPES
#             )
#             service = build('sheets', 'v4', credentials=credentials)
#             logger.info("Successfully authenticated with Google Sheets")
#             return service
            
#         except Exception as e:
#             logger.error(f"Failed to authenticate with Google Sheets: {e}")
#             raise GoogleSheetsError(f"Authentication failed: {e}")
    
#     def _get_range_notation(self, sheet_name: str, range_str: str) -> str:
#         """
#         Get A1 notation for a range
        
#         Args:
#             sheet_name: Name of the sheet
#             range_str: Range in A1 notation (e.g., "A1:B10")
            
#         Returns:
#             Full range notation (e.g., "Dashboard!A1:B10")
#         """
#         return f"{sheet_name}!{range_str}"
    
#     def read_range(self, sheet_name: str, range_str: str) -> List[List[Any]]:
#         """
#         Read values from a range
        
#         Args:
#             sheet_name: Name of the sheet
#             range_str: Range in A1 notation
            
#         Returns:
#             List of rows, each row is a list of values
#         """
#         try:
#             range_notation = self._get_range_notation(sheet_name, range_str)
#             result = self.service.spreadsheets().values().get(
#                 spreadsheetId=self.spreadsheet_id,
#                 range=range_notation
#             ).execute()
            
#             values = result.get('values', [])
#             logger.info(f"Read {len(values)} rows from {range_notation}")
#             return values
            
#         except HttpError as e:
#             logger.error(f"Error reading range {range_notation}: {e}")
#             raise GoogleSheetsError(f"Failed to read range: {e}")
    
#     def write_range(self, sheet_name: str, range_str: str, values: List[List[Any]], 
#                     value_input_option: str = 'USER_ENTERED') -> bool:
#         """
#         Write values to a range
        
#         Args:
#             sheet_name: Name of the sheet
#             range_str: Range in A1 notation
#             values: 2D array of values to write
#             value_input_option: How to interpret input ('RAW' or 'USER_ENTERED')
            
#         Returns:
#             True if successful
#         """
#         try:
#             range_notation = self._get_range_notation(sheet_name, range_str)
#             body = {'values': values}
            
#             result = self.service.spreadsheets().values().update(
#                 spreadsheetId=self.spreadsheet_id,
#                 range=range_notation,
#                 valueInputOption=value_input_option,
#                 body=body
#             ).execute()
            
#             updated_cells = result.get('updatedCells', 0)
#             logger.info(f"Updated {updated_cells} cells in {range_notation}")
#             return True
            
#         except HttpError as e:
#             logger.error(f"Error writing to range {range_notation}: {e}")
#             raise GoogleSheetsError(f"Failed to write range: {e}")
    
#     def append_rows(self, sheet_name: str, values: List[List[Any]], 
#                     value_input_option: str = 'USER_ENTERED') -> bool:
#         """
#         Append rows to the end of a sheet
        
#         Args:
#             sheet_name: Name of the sheet
#             values: 2D array of values to append
#             value_input_option: How to interpret input
            
#         Returns:
#             True if successful
#         """
#         try:
#             body = {'values': values}
            
#             result = self.service.spreadsheets().values().append(
#                 spreadsheetId=self.spreadsheet_id,
#                 range=sheet_name,
#                 valueInputOption=value_input_option,
#                 insertDataOption='INSERT_ROWS',
#                 body=body
#             ).execute()
            
#             updated_rows = result.get('updates', {}).get('updatedRows', 0)
#             logger.info(f"Appended {updated_rows} rows to {sheet_name}")
#             return True
            
#         except HttpError as e:
#             logger.error(f"Error appending to {sheet_name}: {e}")
#             raise GoogleSheetsError(f"Failed to append rows: {e}")
    
#     def clear_range(self, sheet_name: str, range_str: str) -> bool:
#         """
#         Clear values in a range
        
#         Args:
#             sheet_name: Name of the sheet
#             range_str: Range in A1 notation
            
#         Returns:
#             True if successful
#         """
#         try:
#             range_notation = self._get_range_notation(sheet_name, range_str)
            
#             self.service.spreadsheets().values().clear(
#                 spreadsheetId=self.spreadsheet_id,
#                 range=range_notation,
#                 body={}
#             ).execute()
            
#             logger.info(f"Cleared range {range_notation}")
#             return True
            
#         except HttpError as e:
#             logger.error(f"Error clearing range {range_notation}: {e}")
#             raise GoogleSheetsError(f"Failed to clear range: {e}")
    
#     def read_cell(self, sheet_name: str, cell: str) -> Any:
#         """
#         Read a single cell value
        
#         Args:
#             sheet_name: Name of the sheet
#             cell: Cell in A1 notation (e.g., "B10")
            
#         Returns:
#             Cell value or None if empty
#         """
#         values = self.read_range(sheet_name, cell)
#         if values and values[0]:
#             return values[0][0]
#         return None
    
#     def write_cell(self, sheet_name: str, cell: str, value: Any) -> bool:
#         """
#         Write to a single cell
        
#         Args:
#             sheet_name: Name of the sheet
#             cell: Cell in A1 notation
#             value: Value to write
            
#         Returns:
#             True if successful
#         """
#         return self.write_range(sheet_name, cell, [[value]])
    
#     # ==================== Dashboard Operations ====================
    
#     def update_dashboard_stats(self, stats: Dict[str, Any]) -> bool:
#         """
#         Update dashboard statistics
        
#         Args:
#             stats: Dictionary containing dashboard metrics
#                 - total_crimes: Total crimes in database
#                 - pending_crimes: Number of pending crimes
#                 - completed_this_week: Crimes completed this week
#                 - active_members: Number of active members
#                 - last_update: Timestamp of last update
                
#         Returns:
#             True if successful
#         """
#         try:
#             # Prepare data rows
#             values = [
#                 ["Last Updated", datetime.now().strftime("%Y-%m-%d %H:%M:%S")],
#                 ["Total Crimes", stats.get('total_crimes', 0)],
#                 ["Pending Crimes", stats.get('pending_crimes', 0)],
#                 ["Completed This Week", stats.get('completed_this_week', 0)],
#                 ["Active Members", stats.get('active_members', 0)],
#             ]
            
#             self.write_range(self.SHEET_DASHBOARD, "A2:B6", values)
#             logger.info("Updated dashboard statistics")
#             return True
            
#         except Exception as e:
#             logger.error(f"Error updating dashboard: {e}")
#             raise GoogleSheetsError(f"Failed to update dashboard: {e}")
    
#     def update_dashboard_pending_crimes(self, crimes: List[Dict]) -> bool:
#         """
#         Update pending crimes list on dashboard
        
#         Args:
#             crimes: List of pending crime dictionaries
            
#         Returns:
#             True if successful
#         """
#         try:
#             # Clear existing data
#             self.clear_range(self.SHEET_DASHBOARD, "A16:F100")
            
#             # Write headers
#             headers = [["Crime ID", "Name", "Difficulty", "Status", "Slots", "Created"]]
#             self.write_range(self.SHEET_DASHBOARD, "A16:F16", headers)
            
#             # Prepare crime data
#             crime_rows = []
#             for crime in crimes[:50]:  # Limit to 50 most recent
#                 crime_rows.append([
#                     crime.get('id', ''),
#                     crime.get('name', ''),
#                     crime.get('difficulty', ''),
#                     crime.get('status', ''),
#                     f"{len(crime.get('participants', []))}/{crime.get('slots', 0)}",
#                     datetime.fromtimestamp(crime.get('created_at', 0)).strftime("%Y-%m-%d %H:%M")
#                 ])
            
#             if crime_rows:
#                 self.write_range(self.SHEET_DASHBOARD, "A17:F" + str(10 + len(crime_rows)), crime_rows)
            
#             logger.info(f"Updated dashboard with {len(crime_rows)} pending crimes")
#             return True
            
#         except Exception as e:
#             logger.error(f"Error updating pending crimes: {e}")
#             raise GoogleSheetsError(f"Failed to update pending crimes: {e}")
    
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

    def update_member_cpr_scores(self, cpr_data: Dict) -> bool:
        """
        Update CPR scores for members in column C (batched operation)
        
        Args:
            cpr_data: Dictionary of CPR scores by member_id
                {
                    'member_id': {
                        'average_cpr': float,
                        'cpr_by_difficulty': {...}
                    }
                }
        
        Returns:
            True if successful
        """
        logger.info("Updating CPR scores in Members sheet (batched)...")
        
        try:
            # Read member IDs from column A (A2:A102)
            member_ids = self.read_range(self.SHEET_MEMBERS, 'A2:A102')
            
            # Prepare CPR scores for all rows
            cpr_rows = []
            updates_made = 0
            
            for row in member_ids:
                if row and row[0]:  # If cell has a value
                    member_id = str(row[0]).strip()
                    
                    if member_id in cpr_data:
                        # Member has CPR data
                        data = cpr_data[member_id]
                        cpr_score = data.get('average_cpr', 0)
                        
                        # Calculate average if not provided
                        if not cpr_score and 'cpr_by_difficulty' in data:
                            all_cprs = []
                            for diff_data in data['cpr_by_difficulty'].values():
                                all_cprs.extend(diff_data.values())
                            cpr_score = sum(all_cprs) / len(all_cprs) if all_cprs else 0
                        
                        cpr_rows.append([round(cpr_score, 2)])
                        updates_made += 1
                    else:
                        # Member has no CPR data - leave blank
                        cpr_rows.append([''])
                else:
                    # Empty row - stop here
                    break
            
            # Write all CPR scores in one operation (column C only)
            if cpr_rows:
                end_row = 1 + len(cpr_rows)
                self.write_range(
                    self.SHEET_MEMBERS,
                    f'C2:C{end_row}',
                    cpr_rows,
                    value_input_option='RAW'
                )
                logger.info(f"✓ Updated CPR scores for {updates_made} members (1 API call)")
            
            return True
            
        except Exception as e:
            logger.error(f"Error updating CPR scores: {e}")
            raise GoogleSheetsError(f"Failed to update CPR scores: {e}")


    def update_member_tier_data(self, tier_data: Dict) -> bool:
        """
        Update tier data for members in columns D-F (batched operation)
        
        Args:
            tier_data: Dictionary of tier assignments by member_id
                {
                    'member_id': {
                        'tier': int,
                        'previous_tier': int,
                        'changed': bool,
                        'manual_override': bool
                    }
                }
        
        Returns:
            True if successful
        """
        logger.info("Updating tier data in Members sheet (batched)...")
        
        try:
            # Read member IDs from column A (A2:A102)
            member_ids = self.read_range(self.SHEET_MEMBERS, 'A2:A102')
            
            # Prepare tier data for all rows
            tier_rows = []
            updates_made = 0
            
            for row in member_ids:
                if row and row[0]:  # If cell has a value
                    member_id = str(row[0]).strip()
                    
                    if member_id in tier_data:
                        # Member has tier data
                        data = tier_data[member_id]
                        
                        # Determine status
                        if data.get('manual_override'):
                            status = "Manual Override"
                        elif data.get('changed'):
                            if data['tier'] < data['previous_tier']:
                                status = "↑ Promoted"
                            else:
                                status = "↓ Demoted"
                        else:
                            status = "Maintained"
                        
                        # Row: [Current Tier, Previous Tier, Status]
                        tier_rows.append([
                            data.get('tier', ''),
                            data.get('previous_tier', ''),
                            status
                        ])
                        updates_made += 1
                    else:
                        # Member has no tier data - leave blank
                        tier_rows.append(['', '', ''])
                else:
                    # Empty row - stop here
                    break
            
            # Write all tier data in one operation (columns D-F)
            if tier_rows:
                end_row = 1 + len(tier_rows)
                self.write_range(
                    self.SHEET_MEMBERS,
                    f'D2:F{end_row}',
                    tier_rows,
                    value_input_option='RAW'
                )
                logger.info(f"✓ Updated tier data for {updates_made} members (1 API call)")
            
            return True
            
        except Exception as e:
            logger.error(f"Error updating tier data: {e}")
            raise GoogleSheetsError(f"Failed to update tier data: {e}")


    def update_member_data_complete(self, cpr_data: Dict, tier_data: Dict) -> bool:
        """
        Update both CPR scores and tier data in one batch operation
        Most efficient - updates columns C-F all at once
        
        Args:
            cpr_data: Dictionary of CPR scores by member_id
            tier_data: Dictionary of tier assignments by member_id
        
        Returns:
            True if successful
        """
        logger.info("Updating Members sheet with CPR and tier data (batched)...")
        
        try:
            # Read member IDs from column A (A2:A102)
            member_ids = self.read_range(self.SHEET_MEMBERS, 'A2:A102')
            
            # Prepare complete data for all rows
            data_rows = []
            cpr_updates = 0
            tier_updates = 0
            
            for row in member_ids:
                if row and row[0]:  # If cell has a value
                    member_id = str(row[0]).strip()
                    
                    # Get CPR score
                    cpr_score = ''
                    if member_id in cpr_data:
                        data = cpr_data[member_id]
                        cpr_score = data.get('average_cpr', 0)
                        
                        if not cpr_score and 'cpr_by_difficulty' in data:
                            all_cprs = []
                            for diff_data in data['cpr_by_difficulty'].values():
                                all_cprs.extend(diff_data.values())
                            cpr_score = sum(all_cprs) / len(all_cprs) if all_cprs else 0
                        
                        cpr_score = round(cpr_score, 2) if cpr_score else ''
                        if cpr_score:
                            cpr_updates += 1
                    
                    # Get tier data
                    tier = prev_tier = status = ''
                    if member_id in tier_data:
                        tier_info = tier_data[member_id]
                        tier = tier_info.get('tier', '')
                        prev_tier = tier_info.get('previous_tier', '')
                        
                        if tier_info.get('manual_override'):
                            status = "Manual Override"
                        elif tier_info.get('changed'):
                            if tier < prev_tier:
                                status = "↑ Promoted"
                            else:
                                status = "↓ Demoted"
                        else:
                            status = "Maintained"
                        
                        if tier:
                            tier_updates += 1
                    
                    # Row: [CPR Score, Current Tier, Previous Tier, Status]
                    data_rows.append([cpr_score, tier, prev_tier, status])
                else:
                    # Empty row - stop here
                    break
            
            # Write all data in one operation (columns C-F)
            if data_rows:
                end_row = 1 + len(data_rows)
                self.write_range(
                    self.SHEET_MEMBERS,
                    f'C2:F{end_row}',
                    data_rows,
                    value_input_option='RAW'
                )
                logger.info(f"✓ Updated {cpr_updates} CPR scores and {tier_updates} tier assignments (1 API call)")
            
            return True
            
        except Exception as e:
            logger.error(f"Error updating member data: {e}")
            raise GoogleSheetsError(f"Failed to update member data: {e}")

    
    # ==================== Weekly Analysis Operations ====================
    
    def write_weekly_analysis(self, payout_results: List[Dict], from_date: str, to_date: str) -> None:
        """
        Write weekly analysis data with VLOOKUP for member names
        
        Headers: Member ID | Name | Tier | Time (hours) | Base Tickets | 
                Time Penalty | Adjusted Tickets | Crimes Participated | Payout
        """
        logger.info("Writing Weekly_Analysis sheet...")
        
        # Clear old data (keep headers in row 1)
        self.clear_range(self.SHEET_WEEKLY_ANALYSIS, 'A2:I500')
        
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
            end_row = 1 + len(rows)
            self.write_range(
                self.SHEET_WEEKLY_ANALYSIS,
                f'A2:I{end_row}',
                rows,
                value_input_option='USER_ENTERED'  # USER_ENTERED to process formulas
            )
            logger.info(f"Wrote {len(rows)} rows to Weekly_Analysis")
        
        # Update header with date range
        self.write_range(
            self.SHEET_WEEKLY_ANALYSIS,
            'A1:A1',
            [[f'Weekly Analysis: {from_date} to {to_date}']]
        )
        
        logger.info("✓ Weekly_Analysis updated")
    
    # ==================== Payout Operations ====================
    
    def write_payout_data(self, payout_results: List[Dict], from_date: str, to_date: str) -> None:
        """
        Write payout calculator data with VLOOKUP for member names
        
        Headers: Member ID | Name | Adjusted Tickets | Payout | Manual Override | Final Payout
        """
        logger.info("Writing Payout_Calculator sheet...")
        
        # Clear old data (keep headers in row 1, preserve manual overrides)
        # Only clear columns A-D, leave E-F for manual overrides and final payout formulas
        self.clear_range(self.SHEET_PAYOUT, 'A2:D500')
        
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
            end_row = 1 + len(rows)
            self.write_range(
                self.SHEET_PAYOUT,
                f'A2:D{end_row}',
                rows,
                value_input_option='USER_ENTERED'
            )
            
            # Add Final Payout formulas in column F
            # Formula: =IF(E2="",D2,E2) - use override if present, otherwise use calculated
            final_formulas = []
            for i in range(2, end_row + 1):
                final_formulas.append([f'=IF(E{i}="",D{i},E{i})'])
            
            self.write_range(
                self.SHEET_PAYOUT,
                f'F2:F{end_row}',
                final_formulas,
                value_input_option='USER_ENTERED'
            )
            
            logger.info(f"Wrote {len(rows)} rows to Payout_Calculator")
        
        # Update header with date range
        self.write_range(
            self.SHEET_PAYOUT,
            'A1:A1',
            [[f'Payout Calculator: {from_date} to {to_date}']]
        )
        
        # Add totals row
        last_data_row = 1 + len(rows)
        totals_row = last_data_row + 2
        
        totals = [[
            'TOTALS:',
            '',
            f'=SUM(C2:C{last_data_row})',  # Total adjusted tickets
            f'=SUM(D2:D{last_data_row})',  # Total calculated payout
            '',
            f'=SUM(F2:F{last_data_row})'   # Total final payout
        ]]
        
        self.write_range(
            self.SHEET_PAYOUT,
            f'A{totals_row}:F{totals_row}',
            totals,
            value_input_option='USER_ENTERED'
        )
        
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
        Write item outcomes
        
        Headers: ID | Name | Status | Market Value | Quantity | Total Value
        """
        logger.info("Writing item_outcomes sheet...")
        
        # Clear old data
        self.clear_range(self.SHEET_ITEM_OUTCOMES, 'A2:F500')
        
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
            end_row = 1 + len(rows)
            self.write_range(
                self.SHEET_ITEM_OUTCOMES,
                f'A2:F{end_row}',
                rows,
                value_input_option='RAW'
            )
            logger.info(f"Wrote {len(rows)} items to item_outcomes")
        
        # Update header with date range
        self.write_range(
            self.SHEET_ITEM_OUTCOMES,
            'A1:A1',
            [[f'Item Outcomes: {from_date} to {to_date}']]
        )
        
        # Add summary calculations
        last_data_row = 1 + len(rows)
        summary_start = last_data_row + 2
        
        summaries = [
            ['NET TOTAL:', '', '', '', '', f'=SUM(F2:F{last_data_row})'],
            ['REWARDS TOTAL:', '', '', '', '', f'=SUMIF(C2:C{last_data_row},"reward",F2:F{last_data_row})'],
            ['USED TOTAL:', '', '', '', '', f'=SUMIF(C2:C{last_data_row},"used",F2:F{last_data_row})']
        ]
        
        self.write_range(
            self.SHEET_ITEM_OUTCOMES,
            f'A{summary_start}:F{summary_start + 2}',
            summaries,
            value_input_option='USER_ENTERED'
        )
        
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
            self.clear_range(self.SHEET_CRIME_LOG, "A2:H10000")
            
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
            self.write_range(self.SHEET_CRIME_LOG, "A1:H1", headers)
            
            # Write crime data
            if crime_rows:
                end_row = 1 + len(crime_rows)
                self.write_range(self.SHEET_CRIME_LOG, f"A2:H{end_row}", crime_rows)
            
            logger.info(f"Wrote {len(crime_rows)} crimes to Crime_Log sheet")
            return True
            
        except Exception as e:
            logger.error(f"Error writing crime log: {e}")
            raise GoogleSheetsError(f"Failed to write crime log: {e}")
        
    # ==================== Tier Assignment Operations ================

    def write_tier_assignments(self, assignments: Dict) -> bool:
        """
        Write tier assignments to Members sheet
        Updates columns C-G with tier data (A=ID, B=Name from member sync)
        
        Args:
            assignments: Dictionary of tier assignments from assign_tiers.py
                {
                    'member_id': {
                        'tier': int,
                        'score': float,
                        'previous_tier': int,
                        'changed': bool,
                        'manual_override': bool,
                        ...
                    }
                }
        
        Returns:
            True if successful
        """
        logger.info("Writing tier assignments to Members sheet...")
        
        try:
            # Clear old tier data (preserve ID and Name in columns A-B)
            self.clear_range(self.SHEET_MEMBERS, 'C2:G200')
            
            # Prepare tier data rows
            rows = []
            for member_id, data in sorted(assignments.items(), key=lambda x: int(x[0])):
                # Determine status message
                if data.get('manual_override'):
                    status = "Manual Override"
                elif data['changed']:
                    if data['tier'] < data['previous_tier']:
                        status = "↑ Promoted"
                    else:
                        status = "↓ Demoted"
                else:
                    status = "Maintained"
                
                # Row: [Score, Tier, Previous Tier, Status]
                # Columns C-G (A=ID, B=Name already exist)
                row = [
                    round(data['score'], 2),        # Column C: CPR Score
                    data['tier'],                    # Column D: Current Tier
                    data['previous_tier'],           # Column E: Previous Tier
                    status                           # Column F: Status
                ]
                rows.append(row)
            
            # Write tier data
            if rows:
                end_row = 1 + len(rows)
                self.write_range(
                    self.SHEET_MEMBERS,
                    f'C2:F{end_row}',
                    rows,
                    value_input_option='RAW'
                )
                logger.info(f"✓ Updated Members sheet with {len(rows)} tier assignments")
            
            return True
            
        except Exception as e:
            logger.error(f"Error writing tier assignments: {e}")
            raise GoogleSheetsError(f"Failed to write tier assignments: {e}")


    def write_tier_history(self, changes: List[Dict]) -> bool:
        """
        Append tier changes to Tier_History sheet
        
        Args:
            changes: List of tier change dictionaries
                [
                    {
                        'member_id': int,
                        'date': str,
                        'old_tier': int,
                        'new_tier': int,
                        'score': float,
                        'reason': str
                    }
                ]
        
        Returns:
            True if successful
        """
        if not changes:
            logger.info("No tier changes to record")
            return True
        
        logger.info(f"Writing {len(changes)} tier changes to history...")
        
        try:
            # Prepare rows for history
            history_rows = []
            for change in changes:
                row = [
                    change['member_id'],
                    f'=IFERROR(VLOOKUP(A{len(history_rows)+2},Members!$A:$B,2,FALSE),"Unknown")',  # Name VLOOKUP
                    change['date'],
                    change['old_tier'],
                    change['new_tier'],
                    change['score'],
                    change['reason']
                ]
                history_rows.append(row)
            
            # Append to Tier_History sheet
            self.append_rows('Tier_History', history_rows, value_input_option='USER_ENTERED')
            logger.info(f"✓ Recorded {len(history_rows)} tier changes to history")
            
            return True
            
        except Exception as e:
            logger.error(f"Error writing tier history: {e}")
            # Don't raise - history is nice-to-have, not critical
            return False
        
    # ==================== Member Sync Operations ====================

    def sync_faction_members(self, api_key: str) -> Dict[str, str]:
        """
        Sync faction members to Members sheet
        Fetches current faction members and updates IDs and names
        
        Args:
            api_key: Torn API key for faction members endpoint
        
        Returns:
            Dictionary mapping member_id -> member_name
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
                return {}
            
            # Convert list to rows: [id, name] and create id->name mapping
            member_rows = []
            member_names = {}
            
            for member in members_list:
                member_id = member.get('id')
                member_name = member.get('name', 'Unknown')
                
                if member_id:
                    member_rows.append([
                        int(member_id),
                        member_name
                    ])
                    # Store in dictionary for return value
                    member_names[str(member_id)] = member_name
            
            # Sort by ID for consistency
            member_rows.sort(key=lambda x: x[0])
            
            logger.info(f"Fetched {len(member_rows)} faction members")
            
            # Clear existing data (starting from row 2, preserve headers)
            self.clear_range(self.SHEET_MEMBERS, 'A2:B201')
            
            # Write new member data
            if member_rows:
                cell_range = f'A2:B{len(member_rows) + 1}'
                self.write_range(self.SHEET_MEMBERS, cell_range, member_rows, value_input_option='RAW')
                logger.info(f"Updated Members sheet with {len(member_rows)} members")
            
            logger.info("✓ Faction members synced successfully")
            
            # Return the member_id -> name mapping
            return member_names
            
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
        
        props = sheets.get_sheet_properties()
        print(f"✓ Spreadsheet: {props.get('properties', {}).get('title', 'Unknown')}")
        
        print("\nTesting config read...")
        try:
            config = sheets.read_config()
            print(f"✓ Read {len(config)} config values")
        except Exception as e:
            print(f"⚠ Config read failed (sheet may not exist yet): {e}")
        
        print("\nTesting status update...")
        try:
            sheets.update_status("Test successful at " + datetime.now().strftime("%H:%M:%S"))
            print("✓ Status update successful")
        except Exception as e:
            print(f"⚠ Status update failed: {e}")
        
        # Test pandas integration if available
        if PANDAS_AVAILABLE:
            print("\n✓ pandas is available - DataFrame methods enabled")
        else:
            print("\n⚠ pandas not available - install with: pip install pandas")
    else:
        print("✗ Connection failed")