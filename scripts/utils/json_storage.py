"""
JSON Storage utilities for auction house data
"""

import json
import os
import logging
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
    """Manage JSON file storage"""
    
    def __init__(self, data_dir: str = 'data', auto_commit: bool = False):
        """
        Initialize JSON storage manager
        
        Args:
            data_dir: Directory for storing JSON files (default: 'data')
            auto_commit: Whether to automatically commit changes (disabled by default for AH)
        """
        self.data_dir = Path(data_dir)
        self.backups_dir = self.data_dir / 'backups'
        self.auto_commit = auto_commit
        
        # Create directories if they don't exist
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.backups_dir.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"Initialized JSON storage in {self.data_dir}")
    
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
    
    def write_json(self, filename: str, data: Dict, create_backup: bool = True) -> bool:
        """
        Write JSON file to storage
        
        Args:
            filename: Name of the JSON file
            data: Data to write
            create_backup: Whether to create backup before overwriting
            
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
            return True
            
        except Exception as e:
            logger.error(f"Error writing file {filename}: {e}")
            raise JSONStorageError(f"Failed to write {filename}: {e}")
    
    def _create_backup(self, filename: str):
        """Create a backup copy of a file"""
        try:
            file_path = self._get_file_path(filename)
            backup_path = self._get_backup_path(filename)
            
            shutil.copy2(file_path, backup_path)
            logger.info(f"Created backup: {backup_path.name}")
            
        except Exception as e:
            logger.warning(f"Failed to create backup: {e}")
    
    def file_exists(self, filename: str) -> bool:
        """Check if a file exists"""
        return self._get_file_path(filename).exists()
    
    def get_file_path(self, filename: str) -> str:
        """Get the full file path for a filename"""
        return str(self._get_file_path(filename))


# Convenience function
def create_storage_manager(data_dir: str = 'data') -> JSONStorageManager:
    """Create JSONStorageManager instance"""
    return JSONStorageManager(data_dir=data_dir, auto_commit=False)