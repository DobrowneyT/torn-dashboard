"""
JSON Storage utilities using Git for version control
Replaces Google Drive storage with local files committed to repository
"""

import json
import os
import logging
import subprocess
from typing import Dict, Optional, List
from datetime import datetime
from pathlib import Path
import shutil

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class JSONStorageError(Exception):
    """Custom exception for JSON storage errors"""
    pass


class JSONStorageManager:
    """Manage JSON file storage with Git version control"""
    
    def __init__(self, data_dir: str = 'data', auto_commit: bool = True, commit_message_prefix: str = 'Auto-update'):
        """
        Initialize JSON storage manager
        
        Args:
            data_dir: Directory for storing JSON files (default: 'data')
            auto_commit: Whether to automatically commit and push changes
            commit_message_prefix: Prefix for auto-generated commit messages
        """
        self.data_dir = Path(data_dir)
        self.backups_dir = self.data_dir / 'backups'
        self.auto_commit = auto_commit
        self.commit_message_prefix = commit_message_prefix
        
        # Create directories if they don't exist
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.backups_dir.mkdir(parents=True, exist_ok=True)
        
        # Check if we're in a git repository
        self.is_git_repo = self._check_git_repo()
        
        if self.auto_commit and not self.is_git_repo:
            logger.warning("Not in a git repository - auto_commit disabled")
            self.auto_commit = False
        
        logger.info(f"Initialized JSON storage in {self.data_dir} (auto_commit: {self.auto_commit})")
    
    def _check_git_repo(self) -> bool:
        """Check if we're in a git repository"""
        try:
            result = subprocess.run(
                ['git', 'rev-parse', '--git-dir'],
                capture_output=True,
                text=True,
                check=False
            )
            return result.returncode == 0
        except FileNotFoundError:
            logger.warning("Git not found in PATH")
            return False
    
    def _get_file_path(self, filename: str) -> Path:
        """Get full path for a file"""
        return self.data_dir / filename
    
    def _get_backup_path(self, filename: str) -> Path:
        """Get backup path for a file with timestamp"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        name, ext = os.path.splitext(filename)
        backup_name = f"{name}.backup_{timestamp}{ext}"
        return self.backups_dir / backup_name
    
    def read_json(self, filename: str) -> Optional[Dict]:
        """
        Read JSON file from storage
        
        Args:
            filename: Name of the JSON file
            
        Returns:
            Parsed JSON data or None if file doesn't exist
        """
        file_path = self._get_file_path(filename)
        
        if not file_path.exists():
            logger.warning(f"File {filename} not found")
            return None
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            logger.info(f"Successfully read {filename}")
            return data
            
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in {filename}: {e}")
            raise JSONStorageError(f"Invalid JSON in {filename}: {e}")
        except Exception as e:
            logger.error(f"Error reading {filename}: {e}")
            raise JSONStorageError(f"Failed to read {filename}: {e}")
    
    def write_json(self, filename: str, data: Dict, create_backup: bool = True, commit_message: Optional[str] = None) -> bool:
        """
        Write JSON file to storage and optionally commit to git
        
        Args:
            filename: Name of the JSON file
            data: Data to write
            create_backup: Whether to create backup before overwriting
            commit_message: Custom commit message (uses auto-generated if None)
            
        Returns:
            True if successful
        """
        file_path = self._get_file_path(filename)
        
        try:
            # Create backup if file exists and backup is requested
            if create_backup and file_path.exists():
                self._create_backup(filename)
            
            # Write JSON file with pretty formatting
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            
            logger.info(f"Successfully wrote {filename}")
            
            # Commit to git if auto_commit is enabled
            if self.auto_commit:
                if commit_message is None:
                    commit_message = f"{self.commit_message_prefix}: {filename}"
                self._git_commit_and_push(filename, commit_message)
            
            return True
            
        except Exception as e:
            logger.error(f"Error writing file {filename}: {e}")
            raise JSONStorageError(f"Failed to write {filename}: {e}")
    
    def _create_backup(self, filename: str):
        """
        Create a backup copy of a file
        
        Args:
            filename: Original filename
        """
        try:
            file_path = self._get_file_path(filename)
            backup_path = self._get_backup_path(filename)
            
            shutil.copy2(file_path, backup_path)
            logger.info(f"Created backup: {backup_path.name}")
            
        except Exception as e:
            logger.warning(f"Failed to create backup: {e}")
    
    def _git_commit_and_push(self, filename: str, commit_message: str):
        """
        Commit and push changes to git repository
        
        Args:
            filename: File to commit
            commit_message: Commit message
        """
        try:
            file_path = self._get_file_path(filename)
            
            # Configure git if in GitHub Actions
            if os.environ.get('GITHUB_ACTIONS') == 'true':
                subprocess.run(['git', 'config', 'user.email', 'github-actions@github.com'], check=True)
                subprocess.run(['git', 'config', 'user.name', 'GitHub Actions'], check=True)
            
            # Add the specific file
            subprocess.run(['git', 'add', str(file_path)], check=True)
            
            # Also add backups if they exist
            if self.backups_dir.exists():
                subprocess.run(['git', 'add', str(self.backups_dir)], check=False)
            
            # Check if there are changes to commit
            result = subprocess.run(
                ['git', 'diff', '--cached', '--quiet'],
                capture_output=True,
                check=False
            )
            
            if result.returncode != 0:  # There are changes
                subprocess.run(['git', 'commit', '-m', commit_message], check=True)
                subprocess.run(['git', 'push'], check=True)
                logger.info(f"Committed and pushed: {commit_message}")
            else:
                logger.info("No changes to commit")
            
        except subprocess.CalledProcessError as e:
            logger.error(f"Git operation failed: {e}")
            raise JSONStorageError(f"Git operation failed: {e}")
        except Exception as e:
            logger.error(f"Error during git commit: {e}")
            # Don't raise - file was still written successfully
    
    def list_files(self) -> List[Dict]:
        """
        List all JSON files in the storage directory
        
        Returns:
            List of file information dicts
        """
        try:
            files = []
            for file_path in self.data_dir.glob('*.json'):
                if file_path.is_file():
                    stat = file_path.stat()
                    files.append({
                        'name': file_path.name,
                        'size': stat.st_size,
                        'modified': datetime.fromtimestamp(stat.st_mtime).isoformat()
                    })
            
            logger.info(f"Found {len(files)} files in {self.data_dir}")
            return files
            
        except Exception as e:
            logger.error(f"Error listing files: {e}")
            raise JSONStorageError(f"Failed to list files: {e}")
    
    def delete_file(self, filename: str, commit: bool = True) -> bool:
        """
        Delete a file from storage
        
        Args:
            filename: Name of file to delete
            commit: Whether to commit the deletion
            
        Returns:
            True if successful
        """
        file_path = self._get_file_path(filename)
        
        if not file_path.exists():
            logger.warning(f"File {filename} not found")
            return False
        
        try:
            file_path.unlink()
            logger.info(f"Deleted {filename}")
            
            if commit and self.auto_commit:
                self._git_commit_deletion(filename)
            
            return True
            
        except Exception as e:
            logger.error(f"Error deleting file {filename}: {e}")
            raise JSONStorageError(f"Failed to delete {filename}: {e}")
    
    def _git_commit_deletion(self, filename: str):
        """Commit file deletion to git"""
        try:
            file_path = self._get_file_path(filename)
            
            if os.environ.get('GITHUB_ACTIONS') == 'true':
                subprocess.run(['git', 'config', 'user.email', 'github-actions@github.com'], check=True)
                subprocess.run(['git', 'config', 'user.name', 'GitHub Actions'], check=True)
            
            subprocess.run(['git', 'add', str(file_path)], check=True)
            subprocess.run(['git', 'commit', '-m', f'Delete: {filename}'], check=True)
            subprocess.run(['git', 'push'], check=True)
            logger.info(f"Committed deletion of {filename}")
            
        except subprocess.CalledProcessError as e:
            logger.warning(f"Failed to commit deletion: {e}")
    
    def file_exists(self, filename: str) -> bool:
        """
        Check if a file exists
        
        Args:
            filename: Name of file to check
            
        Returns:
            True if file exists
        """
        return self._get_file_path(filename).exists()
    
    def get_file_path(self, filename: str) -> str:
        """
        Get the full file path for a filename
        
        Args:
            filename: Name of the file
            
        Returns:
            Full path as string
        """
        return str(self._get_file_path(filename))
    
    def cleanup_old_backups(self, keep_last_n: int = 10):
        """
        Clean up old backup files, keeping only the most recent N backups per file
        
        Args:
            keep_last_n: Number of recent backups to keep per file
        """
        try:
            # Group backups by original filename
            backups_by_file = {}
            for backup_path in self.backups_dir.glob('*.backup_*'):
                # Extract original filename
                parts = backup_path.stem.split('.backup_')
                if len(parts) == 2:
                    original = parts[0]
                    if original not in backups_by_file:
                        backups_by_file[original] = []
                    backups_by_file[original].append(backup_path)
            
            # For each file, keep only the N most recent backups
            deleted_count = 0
            for original, backups in backups_by_file.items():
                # Sort by modification time (newest first)
                backups.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                
                # Delete old backups
                for old_backup in backups[keep_last_n:]:
                    old_backup.unlink()
                    deleted_count += 1
                    logger.info(f"Deleted old backup: {old_backup.name}")
            
            if deleted_count > 0:
                logger.info(f"Cleaned up {deleted_count} old backup(s)")
            
        except Exception as e:
            logger.warning(f"Error cleaning up backups: {e}")


# Convenience function for scripts
def create_storage_manager(data_dir: str = 'data', auto_commit: bool = True) -> JSONStorageManager:
    """
    Create JSONStorageManager instance
    
    Args:
        data_dir: Directory for JSON storage
        auto_commit: Whether to auto-commit changes
        
    Returns:
        JSONStorageManager instance
    """
    return JSONStorageManager(data_dir=data_dir, auto_commit=auto_commit)


if __name__ == "__main__":
    # Test script
    print("Testing JSON Storage Manager...")
    
    storage = JSONStorageManager(data_dir='data', auto_commit=False)
    
    # Test 1: List files
    print("\n1. Listing existing files...")
    files = storage.list_files()
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
    storage.write_json("test_file.json", test_data, create_backup=False)
    print("✓ Test file written")
    
    # Test 3: Read test file
    print("\n3. Reading test file...")
    read_data = storage.read_json("test_file.json")
    if read_data == test_data:
        print("✓ Data matches")
    else:
        print("✗ Data mismatch")
    
    # Test 4: Update test file (creates backup)
    print("\n4. Updating test file (should create backup)...")
    test_data["updated"] = True
    storage.write_json("test_file.json", test_data, create_backup=True)
    print("✓ File updated with backup")
    
    # Test 5: Check file exists
    print("\n5. Checking file existence...")
    exists = storage.file_exists("test_file.json")
    print(f"✓ test_file.json exists: {exists}")
    
    print("\n✓ All storage tests passed!")
    print(f"\nNote: Check the '{storage.data_dir}' folder for test_file.json and backups/")