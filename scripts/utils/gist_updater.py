"""
GitHub Gist Updater
Updates a public GitHub Gist with the CPR database for public viewing
"""

import os
import json
import logging
import requests
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class GistUpdater:
    """Update GitHub Gist with CPR database"""
    
    def __init__(self):
        """Initialize Gist updater"""
        self.github_token = os.environ.get('GIST_TOKEN')
        self.gist_id = os.environ.get('GIST_ID')  # Optional - will create new if not provided
        self.api_base = "https://api.github.com"
        
        if not self.github_token:
            logger.warning("GIST_TOKEN not set - Gist update will be skipped")
    
    def _read_cpr_database(self) -> Optional[dict]:
        """Read the CPR database from file"""
        cpr_file = Path('data/cpr_database.json')
        
        if not cpr_file.exists():
            logger.error(f"CPR database not found at {cpr_file}")
            return None
        
        try:
            with open(cpr_file, 'r') as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to read CPR database: {e}")
            return None
    
    def _create_gist(self, content: str, description: str = "TNL Forge CPR Database") -> Optional[str]:
        """
        Create a new public Gist
        
        Args:
            content: JSON content to upload
            description: Gist description
            
        Returns:
            Gist ID if successful, None otherwise
        """
        url = f"{self.api_base}/gists"
        headers = {
            "Authorization": f"token {self.github_token}",
            "Accept": "application/vnd.github.v3+json"
        }
        
        data = {
            "description": description,
            "public": True,
            "files": {
                "cpr_database.json": {
                    "content": content
                }
            }
        }
        
        try:
            response = requests.post(url, headers=headers, json=data)
            response.raise_for_status()
            
            gist_data = response.json()
            gist_id = gist_data['id']
            gist_url = gist_data['html_url']
            
            logger.info(f"✓ Created new Gist: {gist_url}")
            logger.info(f"  Gist ID: {gist_id}")
            logger.info(f"  Add this to your GitHub secrets as GIST_ID: {gist_id}")
            
            return gist_id
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to create Gist: {e}")
            if hasattr(e.response, 'text'):
                logger.error(f"Response: {e.response.text}")
            return None
    
    def _update_gist(self, gist_id: str, content: str) -> bool:
        """
        Update an existing Gist
        
        Args:
            gist_id: Gist ID to update
            content: New JSON content
            
        Returns:
            True if successful, False otherwise
        """
        url = f"{self.api_base}/gists/{gist_id}"
        headers = {
            "Authorization": f"token {self.github_token}",
            "Accept": "application/vnd.github.v3+json"
        }
        
        data = {
            "files": {
                "cpr_database.json": {
                    "content": content
                }
            }
        }
        
        try:
            response = requests.patch(url, headers=headers, json=data)
            response.raise_for_status()
            
            gist_data = response.json()
            gist_url = gist_data['html_url']
            
            logger.info(f"✓ Updated Gist: {gist_url}")
            return True
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to update Gist: {e}")
            if hasattr(e.response, 'text'):
                logger.error(f"Response: {e.response.text}")
            return False
    
    def update_cpr_gist(self) -> bool:
        """
        Update or create Gist with CPR database
        
        Returns:
            True if successful, False otherwise
        """
        if not self.github_token:
            logger.warning("Skipping Gist update - no GitHub token configured")
            return False
        
        logger.info("Updating GitHub Gist with CPR database...")
        
        # Read CPR database
        cpr_data = self._read_cpr_database()
        if not cpr_data:
            return False
        
        # Convert to formatted JSON string
        content = json.dumps(cpr_data, indent=2)
        
        # Update existing or create new Gist
        if self.gist_id:
            logger.info(f"Updating existing Gist: {self.gist_id}")
            success = self._update_gist(self.gist_id, content)
        else:
            logger.info("No GIST_ID found - creating new Gist")
            gist_id = self._create_gist(content)
            success = gist_id is not None
        
        if success:
            logger.info("✓ Gist update completed successfully")
        else:
            logger.error("✗ Gist update failed")
        
        return success


def update_gist():
    """Standalone function to update Gist"""
    updater = GistUpdater()
    return updater.update_cpr_gist()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    update_gist()