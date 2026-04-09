"""
OC Optimal Crime Scheduler
Maximizes expected payout per member-day by intelligently assigning members to crimes
"""

import json
import requests
from datetime import datetime, timedelta
from typing import Dict, List, Tuple, Optional, Set
from dataclasses import dataclass
from collections import defaultdict
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class Assignment:
    """Represents a potential member-to-slot assignment"""
    crime_id: str
    crime_name: str
    slot_position: str  # P1, P2, etc.
    role_name: str
    member_id: int
    member_name: str
    member_cpr: float
    required_cpr: float
    success_probability: float
    expected_value: float
    time_until_work: float  # Hours until this member actually starts working


class OCScheduler:
    """Main scheduler for optimal OC assignments"""
    
    def __init__(self, torn_api_key: str):
        self.api_key = torn_api_key
        self.prob_api_base = "https://tornprobability.com:3000/api"
        
        # Load static data
        self.role_weights = self._load_role_weights()
        self.crime_data = self._load_crime_data()
        self.cpr_database = self._load_cpr_database()
        
    def _load_role_weights(self) -> Dict:
        """Fetch role weights from tornprobability API"""
        try:
            response = requests.get(f"{self.prob_api_base}/GetRoleWeights")
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Failed to load role weights: {e}")
            return {}
    
    def _load_crime_data(self) -> Dict:
        """Load crime data from crime_data.json"""
        try:
            with open('data/crime_data.json', 'r') as f:
                data = json.load(f)
            return data['missions']
        except Exception as e:
            logger.error(f"Failed to load crime data: {e}")
            return {}
    
    def _load_cpr_database(self) -> Dict:
        """Load CPR database"""
        try:
            with open('data/cpr_database.json', 'r') as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load CPR database: {e}")
            return {'members': {}}
    
    def get_current_state(self) -> Tuple[List[Dict], List[Dict]]:
        """Fetch current available crimes and members from Torn API"""
        
        # Fetch available crimes
        crimes_url = f"https://api.torn.com/v2/faction/crimes?cat=available&key={self.api_key}"
        crimes_response = requests.get(crimes_url)
        crimes_data = crimes_response.json()
        available_crimes = crimes_data.get('crimes', [])
        
        # Fetch faction members
        members_url = f"https://api.torn.com/v2/faction/members?key={self.api_key}"
        members_response = requests.get(members_url)
        members_data = members_response.json()
        all_members = members_data.get('members', [])
        
        # Filter to only available members (not in OC)
        available_members = [m for m in all_members if not m.get('is_in_oc', False)]
        
        logger.info(f"Found {len(available_crimes)} available crimes")
        logger.info(f"Found {len(available_members)} available members")
        
        return available_crimes, available_members
    
    def _normalize_crime_name(self, name: str) -> str:
        """Normalize crime name for API compatibility"""
        # Remove spaces and special characters, convert to PascalCase
        normalized = name.replace(' ', '').replace('á', 'a').replace('Á', 'A')
        return normalized
    
    def _get_member_cpr(self, member_id: int, role_name: str, crime_level: int) -> float:
        """Get member's CPR for a specific role at crime difficulty level"""
        member_id_str = str(member_id)
        
        # Get from cpr_database
        member_data = self.cpr_database.get('members', {}).get(member_id_str, {})
        cpr_by_role = member_data.get('cpr_by_role', {})
        
        # Look up CPR at the crime difficulty level
        level_str = str(crime_level)
        if level_str in cpr_by_role:
            # Handle different role naming patterns
            base_role = role_name.split(' #')[0]  # Remove #1, #2
            base_role = base_role.split(' 1')[0]   # Remove 1, 2, 3
            base_role = base_role.split(' 2')[0]
            base_role = base_role.split(' 3')[0]
            
            role_cpr = cpr_by_role[level_str].get(base_role, 0)
            return role_cpr
        
        return 0
    
    def calculate_success_probability(self, crime_name: str, slot_cprs: List[float]) -> float:
        """Calculate success probability using tornprobability API"""
        normalized_name = self._normalize_crime_name(crime_name)
        
        try:
            payload = {
                "scenario": normalized_name,
                "parameters": slot_cprs
            }
            
            response = requests.post(
                f"{self.prob_api_base}/CalculateSuccess",
                json=payload,
                headers={'Content-Type': 'application/json'}
            )
            response.raise_for_status()
            result = response.json()
            
            return result.get('successChance', 0)
            
        except Exception as e:
            logger.error(f"Failed to calculate success for {crime_name}: {e}")
            return 0
    
    def calculate_expected_value(self, crime_name: str, slot_cprs: List[float]) -> float:
        """Calculate expected value: success_prob × avg_reward - item_cost"""
        # Get crime data
        crime_key = crime_name.lower().replace(' ', '_')
        crime_info = self.crime_data.get(crime_key, {})
        
        # Calculate average reward
        requirements = crime_info.get('requirements', {})
        min_money = requirements.get('min_money', 0) or 0
        max_money = requirements.get('max_money', 0) or 0
        avg_reward = (min_money + max_money) / 2 if max_money > 0 else min_money
        
        # Get success probability
        success_prob = self.calculate_success_probability(crime_name, slot_cprs)
        
        # Calculate EV (item cost = 0 for now)
        expected_value = success_prob * avg_reward
        
        return expected_value
    
    def _calculate_time_until_work(self, crime: Dict, slot_position: str) -> float:
        """Calculate hours until a member would actually start working in this slot"""
        slots = crime.get('slots', [])
        
        # Find the position number of our slot
        target_position = None
        for slot in slots:
            _pi = slot.get('position_info') or {}
            _pid = _pi.get('id') or slot.get('position_id')
            _pnum = _pi.get('number') or slot.get('position_number')
            if _pid == slot_position:
                target_position = _pnum
                break

        if target_position is None:
            return 0

        # Count how many positions before this one are filled and need to complete
        hours_until_work = 0
        for slot in slots:
            _pi = slot.get('position_info') or {}
            pos_num = _pi.get('number') or slot.get('position_number')
            if pos_num < target_position:
                if slot.get('user') is not None:
                    # Slot is filled - calculate remaining time
                    progress = slot['user'].get('progress', 0)
                    hours_remaining = 24 * (1 - progress / 100)
                    hours_until_work += hours_remaining
                else:
                    # Empty slot before us - assume 24 hours
                    hours_until_work += 24
        
        return hours_until_work
    
    def find_optimal_assignments(self, available_crimes: List[Dict], 
                                available_members: List[Dict]) -> List[Assignment]:
        """Find optimal member-to-slot assignments"""
        
        assignments = []
        used_members = set()
        
        # Build list of all possible assignments with their EVs
        potential_assignments = []
        
        for crime in available_crimes:
            crime_id = crime['id']
            crime_name = crime['name']
            crime_level = crime['difficulty']
            slots = crime.get('slots', [])
            
            # Get all current CPRs for filled slots
            current_cprs = []
            for slot in slots:
                if slot.get('user'):
                    current_cprs.append(slot['checkpoint_pass_rate'])
                else:
                    current_cprs.append(0)  # Placeholder for empty slots
            
            # Find empty slots
            for i, slot in enumerate(slots):
                if slot.get('user') is None:  # Empty slot
                    _pi = slot.get('position_info') or {}
                    slot_position = _pi.get('id') or slot.get('position_id')
                    role_name = slot['position']
                    required_cpr = slot['checkpoint_pass_rate']
                    
                    # Find eligible members for this slot
                    for member in available_members:
                        member_id = member['id']
                        if member_id in used_members:
                            continue
                        
                        member_name = member['name']
                        member_cpr = self._get_member_cpr(member_id, role_name, crime_level)
                        
                        # Skip if member doesn't meet minimum CPR
                        if member_cpr < required_cpr:
                            continue
                        
                        # Calculate expected value with this member
                        test_cprs = current_cprs.copy()
                        test_cprs[i] = member_cpr
                        
                        # Remove zeros (unfilled slots) for EV calculation
                        filled_cprs = [c for c in test_cprs if c > 0]
                        
                        # Only calculate if all slots would be filled
                        if len(filled_cprs) == len(slots):
                            ev = self.calculate_expected_value(crime_name, filled_cprs)
                        else:
                            # Partial EV estimate (pro-rated by filled slots)
                            ev = self.calculate_expected_value(crime_name, filled_cprs) * (len(filled_cprs) / len(slots))
                        
                        # Calculate success probability for this assignment
                        if len(filled_cprs) == len(slots):
                            success_prob = self.calculate_success_probability(crime_name, filled_cprs)
                        else:
                            success_prob = 0  # Can't complete crime yet
                        
                        # Calculate time until this member would work
                        time_until_work = self._calculate_time_until_work(crime, slot_position)
                        
                        # Penalty for long wait times (prefer assignments that start work sooner)
                        time_penalty = max(0, time_until_work - 12) * 0.1  # 10% penalty per hour over 12
                        adjusted_ev = ev * (1 - time_penalty)
                        
                        assignment = Assignment(
                            crime_id=crime_id,
                            crime_name=crime_name,
                            slot_position=slot_position,
                            role_name=role_name,
                            member_id=member_id,
                            member_name=member_name,
                            member_cpr=member_cpr,
                            required_cpr=required_cpr,
                            success_probability=success_prob,
                            expected_value=adjusted_ev,
                            time_until_work=time_until_work
                        )
                        
                        potential_assignments.append(assignment)
        
        # Sort by expected value (descending), then by member CPR (ascending to use lowest viable)
        potential_assignments.sort(key=lambda a: (-a.expected_value, a.member_cpr))
        
        # Greedily assign highest EV assignments
        for assignment in potential_assignments:
            if assignment.member_id not in used_members:
                assignments.append(assignment)
                used_members.add(assignment.member_id)
        
        logger.info(f"Found {len(assignments)} optimal assignments")
        return assignments
    
    def execute_assignments(self, assignments: List[Assignment], dry_run: bool = True):
        """Execute the assignments (assign members to crimes via API)"""
        
        if dry_run:
            logger.info("DRY RUN - No actual assignments will be made")
        
        for assignment in assignments:
            logger.info(f"Assignment: {assignment.member_name} ({assignment.member_cpr:.0f} CPR) -> "
                       f"{assignment.crime_name} [{assignment.role_name}] "
                       f"(EV: ${assignment.expected_value:,.0f}, "
                       f"Success: {assignment.success_probability:.1%}, "
                       f"Wait: {assignment.time_until_work:.1f}h)")
            
            if not dry_run:
                # TODO: Actual API call to assign member to crime
                # This would use the Torn API to join the crime
                pass
    
    def run_optimization(self, dry_run: bool = True):
        """Main entry point: run the complete optimization"""
        logger.info("=" * 60)
        logger.info("OC OPTIMAL SCHEDULER")
        logger.info("=" * 60)
        
        # Get current state
        available_crimes, available_members = self.get_current_state()
        
        # Find optimal assignments
        assignments = self.find_optimal_assignments(available_crimes, available_members)
        
        # Execute assignments
        self.execute_assignments(assignments, dry_run=dry_run)
        
        # Calculate summary metrics
        total_ev = sum(a.expected_value for a in assignments)
        avg_success = sum(a.success_probability for a in assignments) / len(assignments) if assignments else 0
        
        logger.info("=" * 60)
        logger.info(f"OPTIMIZATION SUMMARY")
        logger.info(f"Total Assignments: {len(assignments)}")
        logger.info(f"Total Expected Value: ${total_ev:,.0f}")
        logger.info(f"Average Success Rate: {avg_success:.1%}")
        logger.info("=" * 60)
        
        return assignments


def main():
    """Example usage"""
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python oc_optimal_scheduler.py <TORN_API_KEY> [--execute]")
        sys.exit(1)
    
    api_key = sys.argv[1]
    dry_run = "--execute" not in sys.argv
    
    scheduler = OCScheduler(api_key)
    scheduler.run_optimization(dry_run=dry_run)


if __name__ == "__main__":
    main()