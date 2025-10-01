"""
Payout Calculator
Calculates member payouts using ticket-based system with time penalties
"""

import logging
from typing import Dict, List, Set
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.utils.json_storage import JSONStorageManager
from scripts.utils.torn_api import TornAPI

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class PayoutCalculator:
    """Calculate member payouts based on tickets, tiers, and time spent"""
    
    # Ticket allocation by tier
    TIER_TICKETS = {
        1: 40,
        2: 30,
        3: 15,
        4: 7,
        5: 3
    }
    
    # Time thresholds (in seconds)
    FULL_PAYOUT_THRESHOLD = 432000  # 5 days
    ZERO_PAYOUT_THRESHOLD = 172800  # 2 days
    PENALTY_RANGE = 259200          # 3 days (difference)
    
    def __init__(self):
        """Initialize calculator"""
        self.storage = JSONStorageManager(data_dir='data', auto_commit=False)
        logger.info("Payout Calculator initialized")
    
    def calculate_member_payout(
        self, 
        member_id: int,
        member_data: Dict, 
        tier: int, 
        window_duration: int
    ) -> Dict:
        """
        Calculate payout for a single member
        
        Args:
            member_id: Member ID
            member_data: Member's participation data
            tier: Member's tier (1-5)
            window_duration: Length of analysis window in seconds
            
        Returns:
            Dict with payout calculation details
        """
        if tier not in self.TIER_TICKETS:
            logger.error(f"Invalid tier {tier} for member {member_id}")
            tier = 1  # Default to tier 1
        
        base_tickets = self.TIER_TICKETS[tier]
        time_in_crimes = member_data.get('time_in_crimes', 0)
        
        # Calculate time penalty
        if time_in_crimes >= self.FULL_PAYOUT_THRESHOLD:
            penalty = 0
        elif time_in_crimes < self.ZERO_PAYOUT_THRESHOLD:
            penalty = -base_tickets
        else:
            # Linear scale between thresholds
            time_factor = (time_in_crimes - self.ZERO_PAYOUT_THRESHOLD) / self.PENALTY_RANGE
            penalty = -(1 - time_factor) * base_tickets
        
        adjusted_tickets = base_tickets + penalty
        
        # Ensure non-negative
        if adjusted_tickets < 0:
            adjusted_tickets = 0
        
        return {
            'member_id': member_id,
            'name': member_data.get('name', f"User {member_id}"),
            'tier': tier,
            'time_in_crimes': time_in_crimes,
            'time_in_hours': time_in_crimes / 3600,
            'time_in_days': time_in_crimes / 86400,
            'crimes_participated': member_data.get('crimes_participated', 0),
            'positions': list(member_data.get('positions', [])),
            'base_tickets': base_tickets,
            'time_penalty': penalty,
            'adjusted_tickets': adjusted_tickets,
            'payout': 0  # Will be set during pool distribution
        }
    
    def distribute_payout_pool(
        self, 
        member_payouts: List[Dict], 
        net_pool: float
    ) -> List[Dict]:
        """
        Distribute the net payout pool proportionally based on adjusted tickets
        
        Args:
            member_payouts: List of member payout dicts
            net_pool: Total amount to distribute
            
        Returns:
            Updated member_payouts with payout amounts filled in
        """
        # Calculate total adjusted tickets
        total_tickets = sum(m['adjusted_tickets'] for m in member_payouts)
        
        if total_tickets <= 0:
            logger.warning("No adjusted tickets - no payouts will be distributed")
            for member in member_payouts:
                member['payout'] = 0
            return member_payouts
        
        # Distribute proportionally
        for member in member_payouts:
            member_tickets = member['adjusted_tickets']
            member['payout'] = (member_tickets / total_tickets) * net_pool
        
        logger.info(f"Distributed ${net_pool:,.0f} across {len(member_payouts)} members")
        logger.info(f"Total adjusted tickets: {total_tickets:.2f}")
        
        return member_payouts
    
    def fetch_item_market_values(self, item_ids: Set[int], api_key: str) -> Dict[int, Dict]:
        """
        Fetch item data from Torn API
        
        Args:
            item_ids: Set of item IDs to fetch
            api_key: Torn API key
            
        Returns:
            Dict mapping item_id to item data (name, market_value, sell_price)
        """
        if not item_ids:
            return {}
        
        logger.info(f"Fetching market values for {len(item_ids)} items...")
        
        api = TornAPI(api_key)
        
        try:
            # Convert set to list and pass directly to get_item_data
            # get_item_data already handles URL construction
            result = api.get_item_data(list(item_ids))
            
            items = {}
            for item_id, item_data in result.items():  # No need for .get('items', {}) - result IS the items dict
                items[int(item_id)] = {
                    'name': item_data.get('name', 'Unknown Item'),
                    'market_value': item_data.get('market_value', 0),
                    'sell_price': item_data.get('sell_price', 0)
                }
            
            logger.info(f"Successfully fetched data for {len(items)} items")
            return items
            
        except Exception as e:
            logger.error(f"Failed to fetch item data: {e}")
            import traceback
            traceback.print_exc()
            return {}
    
    def calculate_net_income(
        self, 
        analysis: Dict, 
        item_data: Dict[int, Dict]
    ) -> Dict:
        """
        Calculate net income pool from crimes and items
        
        Args:
            analysis: Analysis results from analyze_window()
            item_data: Item market value data
            
        Returns:
            Dict with income breakdown
        """
        gross_rewards = analysis['crimes']['total_rewards']
        
        # Aggregate items by ID and status
        items_rewarded = {}
        items_used = {}
        
        for item in analysis['items']['rewards']:
            item_id = item['id']
            if item_id not in items_rewarded:
                items_rewarded[item_id] = 0
            items_rewarded[item_id] += item['quantity']
        
        for item in analysis['items']['used']:
            item_id = item['id']
            if item_id not in items_used:
                items_used[item_id] = 0
            items_used[item_id] += item['quantity']
        
        # Calculate values
        item_details = []
        item_rewards_value = 0
        item_used_value = 0
        
        # Process rewarded items
        for item_id, quantity in items_rewarded.items():
            if item_id not in item_data:
                logger.warning(f"No market data for item {item_id}")
                continue
            
            market_value = item_data[item_id]['market_value'] or item_data[item_id]['sell_price']
            total_value = market_value * quantity
            item_rewards_value += total_value
            
            item_details.append({
                'id': item_id,
                'name': item_data[item_id]['name'],
                'status': 'reward',
                'market_value': market_value,
                'quantity': quantity,
                'total_value': total_value
            })
        
        # Process used items
        for item_id, quantity in items_used.items():
            if item_id not in item_data:
                logger.warning(f"No market data for item {item_id}")
                continue
            
            market_value = item_data[item_id]['market_value'] or item_data[item_id]['sell_price']
            total_value = market_value * quantity
            item_used_value += total_value
            
            item_details.append({
                'id': item_id,
                'name': item_data[item_id]['name'],
                'status': 'used',
                'market_value': market_value,
                'quantity': quantity,
                'total_value': total_value
            })
        
        # Calculate net pool
        gross_income = gross_rewards + item_rewards_value - item_used_value
        faction_cut = int(gross_income * 0.2)
        net_pool = gross_income - faction_cut
        
        logger.info(f"Income calculation:")
        logger.info(f"  Gross rewards: ${gross_rewards:,}")
        logger.info(f"  Item rewards: ${item_rewards_value:,}")
        logger.info(f"  Item costs: ${item_used_value:,}")
        logger.info(f"  Gross income: ${gross_income:,}")
        logger.info(f"  Faction cut (20%): ${faction_cut:,}")
        logger.info(f"  Net pool: ${net_pool:,}")
        
        return {
            'gross_rewards': gross_rewards,
            'item_rewards_value': item_rewards_value,
            'item_used_value': item_used_value,
            'gross_income': gross_income,
            'faction_cut': faction_cut,
            'net_pool': net_pool,
            'item_details': item_details
        }


def calculate_payouts(
    members: Dict,
    net_pool: float,
    window_duration: int,
    tier_assignments: Dict[int, int] = None
) -> List[Dict]:
    """
    Convenience function to calculate all member payouts
    
    Args:
        members: Member participation data from analysis
        net_pool: Net payout pool to distribute
        window_duration: Window duration in seconds
        tier_assignments: Dict mapping member_id to tier (optional)
        
    Returns:
        List of member payout dicts
    """
    calculator = PayoutCalculator()
    
    # Load tier assignments from member_tiers.json if not provided
    if tier_assignments is None:
        storage = JSONStorageManager(data_dir='data', auto_commit=False)
        tier_data = storage.read_json('member_tiers.json')
        tier_assignments = tier_data.get('members', {}) if tier_data else {}
    
    member_payouts = []
    
    for member_id, member_data in members.items():
        # Get tier (default to 1 if not assigned)
        tier = tier_assignments.get(str(member_id), 1)
        
        payout = calculator.calculate_member_payout(
            member_id,
            member_data,
            tier,
            window_duration
        )
        
        member_payouts.append(payout)
    
    # Distribute the pool
    member_payouts = calculator.distribute_payout_pool(member_payouts, net_pool)
    
    return member_payouts


if __name__ == "__main__":
    # Test the calculator
    print("\nPayout Calculator Test")
    print("="*60)
    
    # Test ticket calculations
    calculator = PayoutCalculator()
    
    test_cases = [
        (1, 500000, "Tier 1, 5.8 days"),  # Full payout
        (2, 300000, "Tier 2, 3.5 days"),  # Partial payout
        (3, 100000, "Tier 3, 1.2 days"),  # Zero payout
    ]
    
    for tier, time_seconds, description in test_cases:
        result = calculator.calculate_member_payout(
            member_id=12345,
            member_data={'time_in_crimes': time_seconds, 'crimes_participated': 10},
            tier=tier,
            window_duration=604800
        )
        
        print(f"\n{description}:")
        print(f"  Base tickets: {result['base_tickets']}")
        print(f"  Time penalty: {result['time_penalty']:.2f}")
        print(f"  Adjusted tickets: {result['adjusted_tickets']:.2f}")