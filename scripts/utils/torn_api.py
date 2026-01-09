"""
Torn API Wrapper - handles all API calls to Torn City
"""

import requests
import time
import logging
from typing import Dict, List, Optional, Any
from datetime import datetime


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class TornAPIError(Exception):
    """Custom exception for Torn API errors"""
    pass


class TornAPI:
    """Wrapper for Torn City API v2"""
    
    BASE_URL = "https://api.torn.com/v2"
    
    def __init__(self, api_key: str):
        """
        Initialize Torn API wrapper
        
        Args:
            api_key: Torn City API key
        """
        self.api_key = api_key
        self.session = requests.Session()
        self.rate_limit_delay = 0.6  # ~100 requests per minute
        self.last_request_time = 0
        
    def _wait_for_rate_limit(self):
        """Ensure we don't exceed rate limits"""
        current_time = time.time()
        time_since_last = current_time - self.last_request_time
        
        if time_since_last < self.rate_limit_delay:
            time.sleep(self.rate_limit_delay - time_since_last)
        
        self.last_request_time = time.time()
    
    def _make_request(self, url: str, params: Dict = None) -> Dict:
        """
        Make API request with error handling
        
        Args:
            url: Full API URL
            params: Query parameters
            
        Returns:
            Parsed JSON response
            
        Raises:
            TornAPIError: If request fails or API returns error
        """
        self._wait_for_rate_limit()
        
        try:
            logger.info(f"API Request: {url}")
            response = self.session.get(url, params=params, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            
            # Check for API errors
            if 'error' in data:
                error_msg = f"API Error {data['error'].get('code', 'Unknown')}: {data['error'].get('error', 'Unknown error')}"
                logger.error(error_msg)
                raise TornAPIError(error_msg)
            
            return data
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Network error: {e}")
            raise TornAPIError(f"Network error: {e}")
        except ValueError as e:
            logger.error(f"JSON decode error: {e}")
            raise TornAPIError(f"Invalid JSON response: {e}")
    
    def get_auction_house_listings(
        self,
        item_id: int,
        from_timestamp: Optional[int] = None,
        to_timestamp: Optional[int] = None,
        sort: str = "ASC",
        limit: int = 100,
        comment: str = "AH_Listing_Scrape"
    ) -> Dict:
        """
        Get auction house listings for a specific item
        
        Args:
            item_id: Item ID to get listings for
            from_timestamp: Start timestamp for filtering
            to_timestamp: End timestamp for filtering
            sort: Sort order (ASC or DESC)
            limit: Number of results per request (max 100)
            comment: API comment for tracking
            
        Returns:
            Dict with auctionhouse data and metadata
        """
        url = f"{self.BASE_URL}/market/{item_id}/auctionhouse"
        
        params = {
            "limit": limit,
            "sort": sort,
            "key": self.api_key,
            "comment": comment
        }
        
        if from_timestamp is not None:
            params["from"] = from_timestamp
        if to_timestamp is not None:
            params["to"] = to_timestamp
        
        return self._make_request(url, params)
    
    def get_all_auction_house_listings_paginated(
        self,
        item_id: int,
        from_timestamp: Optional[int] = None,
        to_timestamp: Optional[int] = None,
        sort: str = "ASC"
    ) -> List[Dict]:
        """
        Get all auction house listings with automatic pagination
        
        Args:
            item_id: Item ID to get listings for
            from_timestamp: Start timestamp
            to_timestamp: End timestamp
            sort: Sort order
            
        Returns:
            List of all auction listing objects
        """
        all_listings = []
        current_from = from_timestamp
        processed_auction_ids = set()
        page = 1
        
        logger.info(f"Starting paginated AH fetch for item {item_id}")
        logger.info(f"From: {from_timestamp}, To: {to_timestamp}")
        
        while True:
            response = self.get_auction_house_listings(
                item_id=item_id,
                from_timestamp=current_from,
                to_timestamp=to_timestamp,
                sort=sort
            )
            
            listings = response.get('auctionhouse', [])
            
            if not listings:
                logger.info("No more listings to fetch")
                break
            
            logger.info(f"Page {page}: Fetched {len(listings)} listings")
            
            # Add new listings (avoid duplicates by auction_id)
            new_listings_count = 0
            for listing in listings:
                auction_id = listing['id']
                
                # Skip if already processed
                if auction_id in processed_auction_ids:
                    continue
                
                # Stop if we've exceeded the to_timestamp
                if to_timestamp and listing['timestamp'] > to_timestamp:
                    logger.info(f"Reached listings beyond to_timestamp: {to_timestamp}")
                    return all_listings
                
                all_listings.append(listing)
                processed_auction_ids.add(auction_id)
                new_listings_count += 1
                
                # Update pagination marker
                if listing['timestamp'] > (current_from or 0):
                    current_from = listing['timestamp']
            
            logger.info(f"  Added {new_listings_count} new listings (total: {len(all_listings)})")
            
            # If no new listings were added, we're done
            if new_listings_count == 0:
                break
            
            # Check if there are more pages (got exactly 100 listings)
            if len(listings) < 100:
                logger.info("Received less than 100 listings - reached end")
                break
            
            # Check for next page link
            next_link = response.get('_metadata', {}).get('links', {}).get('next')
            if not next_link:
                logger.info("No next page available")
                break
            
            page += 1
        
        logger.info(f"Completed pagination: fetched {len(all_listings)} total listings")
        return all_listings
    
    def get_item_info(self, item_id: int, comment: str = "Item_Info") -> Dict:
        """
        Get item information from Torn API
        
        Args:
            item_id: Item ID to get info for
            
        Returns:
            Dict with item data
        """
        url = f"https://api.torn.com/torn/{item_id}"
        
        params = {
            "selections": "items",
            "key": self.api_key,
            "comment": comment
        }
        
        response = self._make_request(url, params)
        items = response.get('items', {})
        
        # Return the specific item info
        return items.get(str(item_id), {})
    
    def get_faction_crimes(
        self,
        category: str = "all",
        filters: Optional[str] = None,
        from_timestamp: Optional[int] = None,
        to_timestamp: Optional[int] = None,
        offset: int = 0,
        sort: str = "ASC",
        comment: str = "Faction_Crimes"
    ) -> Dict:
        """
        Get faction crimes from API
        
        Args:
            category: Crime category (all, completed, available, etc.)
            filters: Filter field (created_at, executed_at)
            from_timestamp: Start timestamp for filtering
            to_timestamp: End timestamp for filtering
            offset: Pagination offset
            sort: Sort order (ASC or DESC)
            
        Returns:
            Dict with crimes data and metadata
        """
        url = f"{self.BASE_URL}/faction/crimes"
        
        params = {
            "cat": category,
            "sort": sort,
            "key": self.api_key,
            "comment": comment
        }
        
        if filters:
            params["filters"] = filters
        if from_timestamp is not None:
            params["from"] = from_timestamp
        if to_timestamp is not None:
            params["to"] = to_timestamp
        if offset > 0:
            params["offset"] = offset
        
        return self._make_request(url, params)
    
    def test_connection(self) -> bool:
        """
        Test API connection
        
        Returns:
            True if connection successful, False otherwise
        """
        try:
            url = f"{self.BASE_URL}/user"
            params = {
                "key": self.api_key,
                "comment": "Connection_Test"
            }
            
            self._make_request(url, params)
            logger.info("API connection test successful")
            return True
            
        except TornAPIError as e:
            logger.error(f"API connection test failed: {e}")
            return False


# Convenience function for scripts
def create_torn_api(api_key: Optional[str] = None) -> TornAPI:
    """
    Create TornAPI instance with API key from environment or parameter
    
    Args:
        api_key: Optional API key, otherwise reads from environment
        
    Returns:
        TornAPI instance
    """
    import os
    
    if api_key is None:
        api_key = os.environ.get('TORN_API_KEY')
    
    if not api_key:
        raise ValueError("TORN_API_KEY not found in environment or parameters")
    
    return TornAPI(api_key)


if __name__ == "__main__":
    # Test script
    import os
    
    api_key = os.environ.get('TORN_API_KEY')
    if not api_key:
        print("Error: TORN_API_KEY environment variable not set")
        exit(1)
    
    api = TornAPI(api_key)
    
    print("Testing API connection...")
    if api.test_connection():
        print("✓ Connection successful")
    else:
        print("✗ Connection failed")