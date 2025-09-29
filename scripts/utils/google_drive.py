"""
Google Drive utilities for storing and retrieving JSON data
"""

import json
import os
import logging
from typing import Dict, Optional, List
from datetime import datetime
from io import BytesIO

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload, MediaIoBaseDownload
from googleapiclient.errors import HttpError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class GoogleDriveError(Exception):
    """Custom exception for Google Drive errors"""
    pass


class GoogleDriveManager:
    """Manage JSON file storage in Google Drive"""
    
    SCOPES = ['https://www.googleapis.com/auth/drive']
    
    def __init__(self, credentials_file: str = 'google_credentials.json', folder_id: Optional[str] = None, owner_email: Optional[str] = None):
        """
        Initialize Google Drive manager
        
        Args:
            credentials_file: Path to service account credentials JSON
            folder_id: Google Drive folder ID for storage
            owner_email: Email of the Google account that owns the folder (to transfer file ownership)
        """
        self.credentials_file = credentials_file
        self.folder_id = folder_id or os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
        self.owner_email = owner_email or os.environ.get('GOOGLE_DRIVE_OWNER_EMAIL')
        
        if not self.folder_id:
            raise ValueError("folder_id must be provided or set in GOOGLE_DRIVE_FOLDER_ID environment variable")
        
        if not self.owner_email:
            raise ValueError("owner_email must be provided or set in GOOGLE_DRIVE_OWNER_EMAIL environment variable")
        
        self.service = self._authenticate()
        
    def _authenticate(self):
        """Authenticate with Google Drive API"""
        try:
            credentials = service_account.Credentials.from_service_account_file(
                self.credentials_file,
                scopes=self.SCOPES
            )
            service = build('drive', 'v3', credentials=credentials)
            logger.info("Successfully authenticated with Google Drive")
            return service
            
        except Exception as e:
            logger.error(f"Failed to authenticate with Google Drive: {e}")
            raise GoogleDriveError(f"Authentication failed: {e}")
    
    def _get_file_id(self, filename: str) -> Optional[str]:
        """
        Get file ID by name in the specified folder
        
        Args:
            filename: Name of the file
            
        Returns:
            File ID if found, None otherwise
        """
        try:
            query = f"name='{filename}' and '{self.folder_id}' in parents and trashed=false"
            results = self.service.files().list(
                q=query,
                spaces='drive',
                fields='files(id, name)'
            ).execute()
            
            files = results.get('files', [])
            
            if files:
                return files[0]['id']
            return None
            
        except HttpError as e:
            logger.error(f"Error searching for file {filename}: {e}")
            return None
    
    def read_json(self, filename: str) -> Optional[Dict]:
        """
        Read JSON file from Google Drive
        
        Args:
            filename: Name of the JSON file
            
        Returns:
            Parsed JSON data or None if file doesn't exist
        """
        file_id = self._get_file_id(filename)
        
        if not file_id:
            logger.warning(f"File {filename} not found in Drive")
            return None
        
        try:
            request = self.service.files().get_media(fileId=file_id)
            file_content = BytesIO()
            downloader = MediaIoBaseDownload(file_content, request)
            
            done = False
            while not done:
                status, done = downloader.next_chunk()
            
            file_content.seek(0)
            data = json.load(file_content)
            logger.info(f"Successfully read {filename} from Drive")
            return data
            
        except HttpError as e:
            logger.error(f"Error reading file {filename}: {e}")
            raise GoogleDriveError(f"Failed to read {filename}: {e}")
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in {filename}: {e}")
            raise GoogleDriveError(f"Invalid JSON in {filename}: {e}")
    
    def write_json(self, filename: str, data: Dict, create_backup: bool = True) -> bool:
        """
        Write JSON file to Google Drive with ownership transfer
        
        Args:
            filename: Name of the JSON file
            data: Data to write
            create_backup: Whether to create backup before overwriting
            
        Returns:
            True if successful
        """
        try:
            # Create backup if file exists and backup is requested
            if create_backup:
                existing_file_id = self._get_file_id(filename)
                if existing_file_id:
                    self._create_backup(filename, existing_file_id)
            
            # Convert data to JSON bytes
            json_data = json.dumps(data, indent=2)
            file_content = BytesIO(json_data.encode('utf-8'))
            
            media = MediaIoBaseUpload(
                file_content,
                mimetype='application/json',
                resumable=True
            )
            
            # Check if file exists
            file_id = self._get_file_id(filename)
            
            if file_id:
                # Update existing file
                self.service.files().update(
                    fileId=file_id,
                    media_body=media
                ).execute()
                logger.info(f"Updated {filename} in Drive")
            else:
                # Create new file
                file_metadata = {
                    'name': filename,
                    'parents': [self.folder_id]
                }
                file = self.service.files().create(
                    body=file_metadata,
                    media_body=media,
                    fields='id'
                ).execute()
                
                file_id = file['id']
                logger.info(f"Created {filename} in Drive")
                
                # Transfer ownership to avoid quota issues
                self._transfer_ownership(file_id, filename)
            
            return True
            
        except HttpError as e:
            logger.error(f"Error writing file {filename}: {e}")
            raise GoogleDriveError(f"Failed to write {filename}: {e}")
    
    def _transfer_ownership(self, file_id: str, filename: str):
        """
        Transfer file ownership to the folder owner to avoid quota issues
        
        Args:
            file_id: ID of the file
            filename: Name of the file (for logging)
        """
        try:
            # Add owner permission
            permission = {
                'type': 'user',
                'role': 'owner',
                'emailAddress': self.owner_email
            }
            
            self.service.permissions().create(
                fileId=file_id,
                body=permission,
                transferOwnership=True,
                fields='id'
            ).execute()
            
            logger.info(f"Transferred ownership of {filename} to {self.owner_email}")
            
        except HttpError as e:
            # Log warning but don't fail - file was still created
            logger.warning(f"Could not transfer ownership of {filename}: {e}")
    
    def _create_backup(self, filename: str, file_id: str):
        """
        Create a backup copy of a file
        
        Args:
            filename: Original filename
            file_id: ID of the file to backup
        """
        try:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            backup_name = f"{filename}.backup_{timestamp}"
            
            # Check if backups folder exists, create if not
            backups_folder_id = self._get_or_create_backups_folder()
            
            # Copy file to backups folder
            file_metadata = {
                'name': backup_name,
                'parents': [backups_folder_id]
            }
            
            self.service.files().copy(
                fileId=file_id,
                body=file_metadata
            ).execute()
            
            logger.info(f"Created backup: {backup_name}")
            
        except HttpError as e:
            logger.warning(f"Failed to create backup: {e}")
    
    def _get_or_create_backups_folder(self) -> str:
        """
        Get or create the backups subfolder
        
        Returns:
            Folder ID of backups folder
        """
        try:
            # Check if backups folder exists
            query = f"name='backups' and '{self.folder_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false"
            results = self.service.files().list(
                q=query,
                spaces='drive',
                fields='files(id, name)'
            ).execute()
            
            files = results.get('files', [])
            
            if files:
                return files[0]['id']
            
            # Create backups folder
            file_metadata = {
                'name': 'backups',
                'mimeType': 'application/vnd.google-apps.folder',
                'parents': [self.folder_id]
            }
            
            folder = self.service.files().create(
                body=file_metadata,
                fields='id'
            ).execute()
            
            logger.info("Created backups folder")
            return folder['id']
            
        except HttpError as e:
            logger.error(f"Error with backups folder: {e}")
            raise GoogleDriveError(f"Failed to manage backups folder: {e}")
    
    def list_files(self) -> List[Dict]:
        """
        List all JSON files in the folder
        
        Returns:
            List of file information dicts
        """
        try:
            query = f"'{self.folder_id}' in parents and trashed=false and mimeType='application/json'"
            results = self.service.files().list(
                q=query,
                spaces='drive',
                fields='files(id, name, modifiedTime, size)'
            ).execute()
            
            files = results.get('files', [])
            logger.info(f"Found {len(files)} files in Drive folder")
            return files
            
        except HttpError as e:
            logger.error(f"Error listing files: {e}")
            raise GoogleDriveError(f"Failed to list files: {e}")
    
    def delete_file(self, filename: str) -> bool:
        """
        Delete a file from Drive
        
        Args:
            filename: Name of file to delete
            
        Returns:
            True if successful
        """
        file_id = self._get_file_id(filename)
        
        if not file_id:
            logger.warning(f"File {filename} not found")
            return False
        
        try:
            self.service.files().delete(fileId=file_id).execute()
            logger.info(f"Deleted {filename} from Drive")
            return True
            
        except HttpError as e:
            logger.error(f"Error deleting file {filename}: {e}")
            raise GoogleDriveError(f"Failed to delete {filename}: {e}")
    
    def file_exists(self, filename: str) -> bool:
        """
        Check if a file exists
        
        Args:
            filename: Name of file to check
            
        Returns:
            True if file exists
        """
        return self._get_file_id(filename) is not None


# Convenience function for scripts
def create_drive_manager(credentials_file: str = 'google_credentials.json', 
                        folder_id: Optional[str] = None,
                        owner_email: Optional[str] = None) -> GoogleDriveManager:
    """
    Create GoogleDriveManager instance
    
    Args:
        credentials_file: Path to credentials JSON
        folder_id: Optional folder ID, otherwise reads from environment
        owner_email: Optional owner email, otherwise reads from environment
        
    Returns:
        GoogleDriveManager instance
    """
    return GoogleDriveManager(credentials_file, folder_id, owner_email)


if __name__ == "__main__":
    # Test script
    import os
    
    folder_id = os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
    owner_email = os.environ.get('GOOGLE_DRIVE_OWNER_EMAIL')
    
    if not folder_id:
        print("Error: GOOGLE_DRIVE_FOLDER_ID environment variable not set")
        exit(1)
    
    if not owner_email:
        print("Error: GOOGLE_DRIVE_OWNER_EMAIL environment variable not set")
        print("This should be YOUR Gmail address (the one that owns the folder)")
        exit(1)
    
    if not os.path.exists('google_credentials.json'):
        print("Error: google_credentials.json not found")
        exit(1)
    
    print(f"Testing Google Drive connection...")
    print(f"Files will be owned by: {owner_email}")
    drive = GoogleDriveManager(folder_id=folder_id, owner_email=owner_email)
    
    # Test 1: List files
    print("\n1. Listing existing files...")
    files = drive.list_files()
    print(f"✓ Found {len(files)} files")
    for file in files:
        print(f"  - {file['name']}")
    
    # Test 2: Write test file
    print("\n2. Writing test file...")
    test_data = {
        "test": "data",
        "timestamp": datetime.now().isoformat(),
        "items": [1, 2, 3]
    }
    drive.write_json("test_file.json", test_data)
    print("✓ Test file written")
    
    # Test 3: Read test file
    print("\n3. Reading test file...")
    read_data = drive.read_json("test_file.json")
    if read_data == test_data:
        print("✓ Data matches")
    else:
        print("✗ Data mismatch")
    
    # Test 4: Update test file (creates backup)
    print("\n4. Updating test file (should create backup)...")
    test_data["updated"] = True
    drive.write_json("test_file.json", test_data, create_backup=True)
    print("✓ File updated with backup")
    
    # Test 5: Check file exists
    print("\n5. Checking file existence...")
    exists = drive.file_exists("test_file.json")
    print(f"✓ test_file.json exists: {exists}")
    
    print("\n✓ All Drive tests passed!")
    print("\nNote: Check your Drive folder for test_file.json and backups/")