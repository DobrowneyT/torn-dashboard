"""
Tier Assignment Script
Automatically assigns member tiers based on CPR performance data
Uses proportion-based evaluation with top-down tier checking and KNN predictions
"""

import json
import logging
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple, Optional
import math
from collections import Counter

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.utils.google_sheets import GoogleSheetsManager

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class TierAssignment:
    """Handles automatic tier assignment based on CPR data"""
    
    # Tier requirements: each tier has list of (level, role, min_cpr) tuples
    # For averages, use ("avg", level, min_cpr)
    TIER_REQUIREMENTS = {
        1: [
            (8, "Imitator", 70),
            (8, "Muscle", 65),
            (8, "Thief", 65)
        ],
        2: [
            (8, "Muscle", 60),
            (8, "Robber", 60),
            (8, "Assassin", 67),
            (8, "Cat Burglar", 67),
            (8, "Cleaner", 67),
            (7, "Muscle", 75),
            (7, "Engineer", 75),
            (7, "Bomber", 75)
        ],
        3: [
            (7, "Hacker", 70),
            (7, "Picklock", 70),
            (6, "Bomber", 75),
            (6, "Driver", 75),
            (6, "Robber", 75)
        ],
        4: [
            (6, "Bomber", 70),
            (6, "Robber", 70),
            (6, "Enforcer", 75),
            (6, "Muscle", 75)
        ],
        5: [
            ("avg", 5, 75)  # Average of all Level 5 roles >= 75
        ],
        6: [
            ("avg", 4, 75)  # Average of all Level 4 roles >= 75
        ]
    }
    
    def __init__(self, proportion_threshold: float = 2/3, knn_k: int = 5):
        """
        Initialize tier assignment system
        
        Args:
            proportion_threshold: Proportion of requirements that must be met (default: 2/3)
            knn_k: Number of neighbors for KNN prediction (default: 5)
        """
        self.proportion_threshold = proportion_threshold
        self.knn_k = knn_k
        self.cpr_data = self.load_cpr_data()
        self.existing_tiers = self.load_existing_tiers()
        self.knn_list = []  # Members with partial data for second pass
        self.members_no_data = []  # Members with no data at all
        self.pass1_assignments = {}  # Store Pass 1 results for KNN
        
        # Calculate requirements needed for each tier (using ceiling)
        self.tier_requirements_needed = {
            tier: math.ceil(len(reqs) * self.proportion_threshold)
            for tier, reqs in self.TIER_REQUIREMENTS.items()
        }
        
        logger.info(f"Tier requirements (need to meet):")
        for tier in sorted(self.TIER_REQUIREMENTS.keys()):
            total = len(self.TIER_REQUIREMENTS[tier])
            needed = self.tier_requirements_needed[tier]
            logger.info(f"  Tier {tier}: {needed}/{total} requirements")
    
    def load_cpr_data(self) -> Dict:
        """Load CPR database"""
        path = "data/cpr_database.json"
        logger.info(f"Loading CPR data from {path}")
        try:
            with open(path, 'r') as f:
                data = json.load(f)
            
            # Extract data from 'members' if nested
            if 'members' in data:
                members = data['members']
            else:
                members = data
            
            logger.info(f"✓ Loaded CPR data for {len(members)} members")
            return members
        except FileNotFoundError:
            logger.warning(f"CPR database not found: {path}")
            return {}
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in CPR database: {e}")
            return {}
    
    def load_existing_tiers(self) -> Dict:
        """Load existing tier assignments"""
        path = "data/member_tiers.json"
        logger.info(f"Loading existing tiers from {path}")
        try:
            with open(path, 'r') as f:
                data = json.load(f)
            logger.info(f"✓ Loaded existing tiers for {len(data)} members")
            return data
        except FileNotFoundError:
            logger.warning(f"Tier file not found: {path}, will create new")
            return {}
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in tier file: {e}")
            return {}
    
    def get_cpr_value(self, member_data: Dict, level: int, role: str) -> Optional[float]:
        """
        Get CPR value for a specific level and role
        
        Returns:
            CPR value or None if not available
        """
        cpr_data = member_data.get('cpr_by_role', {})
        
        # Try level as string (both "6" and "Level 6" formats)
        level_key = str(level)
        if level_key not in cpr_data:
            level_key = f"Level {level}"
            if level_key not in cpr_data:
                return None
        
        level_data = cpr_data[level_key]
        return level_data.get(role)
    
    def calculate_level_average(self, member_data: Dict, level: int) -> Optional[float]:
        """
        Calculate average CPR across all roles for a given level
        
        Returns:
            Average CPR or None if no data available
        """
        cpr_data = member_data.get('cpr_by_role', {})
        
        # Try level as string (both formats)
        level_key = str(level)
        if level_key not in cpr_data:
            level_key = f"Level {level}"
            if level_key not in cpr_data:
                return None
        
        level_data = cpr_data[level_key]
        cpr_values = [v for v in level_data.values() if isinstance(v, (int, float))]
        
        if not cpr_values:
            return None
        
        return sum(cpr_values) / len(cpr_values)
    
    def evaluate_requirement(self, member_data: Dict, requirement: Tuple) -> Tuple[bool, bool]:
        """
        Evaluate a single requirement for a member
        
        Args:
            member_data: Member's CPR data
            requirement: (level, role, min_cpr) or ("avg", level, min_cpr)
        
        Returns:
            (requirement_met, data_available)
        """
        if requirement[0] == "avg":
            # Average requirement
            _, level, min_cpr = requirement
            avg_cpr = self.calculate_level_average(member_data, level)
            
            if avg_cpr is None:
                return False, False
            
            return avg_cpr >= min_cpr, True
        else:
            # Specific role requirement
            level, role, min_cpr = requirement
            cpr_value = self.get_cpr_value(member_data, level, role)
            
            if cpr_value is None:
                return False, False
            
            return cpr_value >= min_cpr, True
    
    def check_tier_requirements(self, member_id: str, member_data: Dict, tier: int) -> Dict:
        """
        Check tier requirements and return detailed status
        
        Returns:
            Dict with:
                - 'meets_threshold': bool - Has enough requirements met
                - 'requirements_met': int - Number of requirements satisfied
                - 'requirements_needed': int - Number needed for tier
                - 'data_points_available': int - Number of requirements with data
                - 'missing_data': List[str] - Requirements without data
                - 'failed_requirements': List[str] - Requirements with data but not met
        """
        requirements = self.TIER_REQUIREMENTS[tier]
        requirements_needed = self.tier_requirements_needed[tier]
        
        requirements_met = 0
        data_points_available = 0
        missing_data = []
        failed_requirements = []
        
        for req in requirements:
            met, data_available = self.evaluate_requirement(member_data, req)
            
            if data_available:
                data_points_available += 1
                if met:
                    requirements_met += 1
                else:
                    # Has data but didn't meet threshold
                    if req[0] == "avg":
                        failed_requirements.append(f"Level {req[1]} Average")
                    else:
                        failed_requirements.append(f"Level {req[0]} {req[1]}")
            else:
                # Missing data
                if req[0] == "avg":
                    missing_data.append(f"Level {req[1]} Average")
                else:
                    missing_data.append(f"Level {req[0]} {req[1]}")
        
        meets_threshold = requirements_met >= requirements_needed
        
        return {
            'meets_threshold': meets_threshold,
            'requirements_met': requirements_met,
            'requirements_needed': requirements_needed,
            'data_points_available': data_points_available,
            'missing_data': missing_data,
            'failed_requirements': failed_requirements
        }
    
    def get_all_cpr_datapoints(self, member_data: Dict) -> List[Tuple[int, str, float]]:
        """
        Get all CPR data points for a member
        
        Returns:
            List of (level, role, cpr_value) tuples
        """
        cpr_data = member_data.get('cpr_by_role', {})
        datapoints = []
        
        for level_key, roles in cpr_data.items():
            # Parse level number
            if level_key.startswith("Level"):
                level = int(level_key.split()[1])
            else:
                level = int(level_key)
            
            for role, cpr in roles.items():
                if isinstance(cpr, (int, float)):
                    datapoints.append((level, role, cpr))
        
        return datapoints
    
    def assign_tier_pass1(self, member_id: str, member_data: Dict) -> Optional[Dict]:
        """
        First pass: Assign tier based only on available data
        
        Logic:
        - Check tiers 1-6 top-down
        - Has ALL data + meets threshold → assign tier
        - Has ALL data but doesn't meet threshold OR has 0 data → check next tier
        - Has PARTIAL data → add to KNN list and STOP
        
        Returns:
            Assignment dict or None if needs KNN (added to knn_list)
        """
        # Check for manual override
        if member_id in self.existing_tiers:
            existing = self.existing_tiers[member_id]
            if existing.get('manual_override', False):
                logger.info(f"Member {member_id}: Manual override - Tier {existing['tier']}")
                return {
                    'tier': existing['tier'],
                    'previous_tier': existing.get('tier'),
                    'changed': False,
                    'manual_override': True,
                    'override_reason': existing.get('override_reason', 'Manual assignment'),
                    'total_crimes': member_data.get('total_crimes', 0),
                    'requirements_met': 0,
                    'requirements_needed': 0,
                    'assignment_method': 'manual_override',
                    'last_updated': datetime.now().isoformat()
                }
        
        # Get all available data points for this member
        all_datapoints = self.get_all_cpr_datapoints(member_data)
        
        if not all_datapoints:
            # No CPR data at all - assign to Tier -1 for manual review
            self.members_no_data.append({
                'member_id': member_id,
                'reason': 'No CPR data available',
                'total_crimes': member_data.get('total_crimes', 0)
            })
            logger.warning(f"Member {member_id}: No CPR data - assigned to Tier -1 for MANUAL REVIEW")
            
            previous_tier = self.existing_tiers.get(member_id, {}).get('tier', -1)
            
            return {
                'tier': -1,
                'previous_tier': previous_tier,
                'changed': -1 != previous_tier,
                'total_crimes': member_data.get('total_crimes', 0),
                'requirements_met': 0,
                'requirements_needed': 0,
                'manual_override': False,
                'assignment_method': '⚠️ NO_DATA_MANUAL_REVIEW_REQUIRED',
                'last_updated': datetime.now().isoformat()
            }
        
        # Check tiers 1-6 top-down
        for tier in range(1, 7):
            status = self.check_tier_requirements(member_id, member_data, tier)
            total_requirements = len(self.TIER_REQUIREMENTS[tier])
            
            # Case 1: Has 0 data points for this tier → check next tier
            if status['data_points_available'] == 0:
                logger.debug(f"Member {member_id} Tier {tier}: 0/{total_requirements} data points, checking next tier")
                continue
            
            # Case 2: Has PARTIAL data (not all requirements have data) → add to KNN and STOP
            if status['data_points_available'] < total_requirements:
                self.knn_list.append({
                    'member_id': member_id,
                    'member_data': member_data,
                    'datapoints': all_datapoints
                })
                logger.info(f"Member {member_id}: Partial data at Tier {tier} "
                          f"({status['data_points_available']}/{total_requirements} requirements have data), "
                          f"added to KNN list")
                return None
            
            # Case 3: Has ALL data points for this tier
            if status['meets_threshold']:
                # Assign this tier
                previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 6)
                changed = tier != previous_tier
                
                if changed:
                    direction = "↑" if tier < previous_tier else "↓"
                    logger.info(f"Member {member_id}: {direction} Tier {previous_tier} → {tier} "
                              f"({status['requirements_met']}/{status['requirements_needed']})")
                
                return {
                    'tier': tier,
                    'previous_tier': previous_tier,
                    'changed': changed,
                    'total_crimes': member_data.get('total_crimes', 0),
                    'requirements_met': status['requirements_met'],
                    'requirements_needed': status['requirements_needed'],
                    'manual_override': False,
                    'assignment_method': 'pass1_requirements',
                    'last_updated': datetime.now().isoformat()
                }
            else:
                # Has all data but doesn't meet threshold → check next tier
                logger.debug(f"Member {member_id} Tier {tier}: Has all data but doesn't meet threshold "
                           f"({status['requirements_met']}/{status['requirements_needed']}), checking next tier")
                continue
        
        # If we get here, member didn't qualify for any tier 1-6
        # This should be rare - means they have full data for all tiers but don't meet any threshold
        logger.warning(f"Member {member_id}: Has data but doesn't qualify for any tier → Default Tier 6")
        
        previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 6)
        
        return {
            'tier': 6,
            'previous_tier': previous_tier,
            'changed': 6 != previous_tier,
            'total_crimes': member_data.get('total_crimes', 0),
            'requirements_met': 0,
            'requirements_needed': 0,
            'manual_override': False,
            'assignment_method': 'pass1_default_tier6',
            'last_updated': datetime.now().isoformat()
        }
    
    def find_knn_for_datapoint(self, level: int, role: str, cpr_value: float) -> List[int]:
        """
        Find K nearest neighbors for a specific datapoint from Pass 1 assignments
        
        Returns:
            List of tier assignments from K nearest neighbors
        """
        neighbors = []
        
        # Find all members from Pass 1 with this level/role
        for other_id, other_assignment in self.pass1_assignments.items():
            other_data = self.cpr_data[other_id]
            other_cpr = self.get_cpr_value(other_data, level, role)
            
            if other_cpr is not None:
                distance = abs(cpr_value - other_cpr)
                neighbors.append((distance, other_assignment['tier'], other_id, other_cpr))
        
        # Need at least K neighbors
        if len(neighbors) < self.knn_k:
            return []
        
        # Sort by distance and take K nearest
        nearest = sorted(neighbors, key=lambda x: x[0])[:self.knn_k]
        tiers = [n[1] for n in nearest]
        
        logger.debug(f"  Level {level} {role} (CPR={cpr_value:.1f}): "
                   f"K={self.knn_k} neighbors → tiers {tiers}")
        
        return tiers
    
    def assign_tier_knn(self, member_id: str, member_data: Dict, datapoints: List[Tuple[int, str, float]]) -> Dict:
        """
        Second pass: Assign tier using KNN on available datapoints
        
        Logic:
        - For each datapoint, find K nearest neighbors from Pass 1
        - Each datapoint votes for a tier (majority among its K neighbors)
        - Final tier = majority vote across all datapoint predictions
        - Ties go to lower (better) tier
        
        Returns:
            Assignment dict
        """
        role_predictions = []
        prediction_details = []
        
        for level, role, cpr_value in datapoints:
            neighbor_tiers = self.find_knn_for_datapoint(level, role, cpr_value)
            
            if not neighbor_tiers:
                # Not enough neighbors for this role
                logger.debug(f"  Level {level} {role}: Not enough neighbors (need {self.knn_k})")
                continue
            
            # Majority vote among neighbors
            vote_counts = Counter(neighbor_tiers)
            predicted_tier = vote_counts.most_common(1)[0][0]
            confidence = vote_counts[predicted_tier] / len(neighbor_tiers)
            
            role_predictions.append(predicted_tier)
            prediction_details.append({
                'role': f"Level {level} {role}",
                'cpr': cpr_value,
                'predicted_tier': predicted_tier,
                'confidence': confidence,
                'neighbor_votes': dict(vote_counts)
            })
        
        if not role_predictions:
            # Could not make any predictions - default to Tier 6
            logger.warning(f"Member {member_id}: KNN failed (not enough neighbors) → Tier 6")
            
            previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 6)
            
            return {
                'tier': 6,
                'previous_tier': previous_tier,
                'changed': 6 != previous_tier,
                'total_crimes': member_data.get('total_crimes', 0),
                'requirements_met': 0,
                'requirements_needed': 0,
                'manual_override': False,
                'assignment_method': 'knn_failed_default_tier6',
                'last_updated': datetime.now().isoformat()
            }
        
        # Final majority vote across all role predictions
        final_vote_counts = Counter(role_predictions)
        
        # In case of tie, choose lower (better) tier
        max_votes = max(final_vote_counts.values())
        tied_tiers = [tier for tier, votes in final_vote_counts.items() if votes == max_votes]
        final_tier = min(tied_tiers)
        
        previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 6)
        changed = final_tier != previous_tier
        
        if changed:
            direction = "↑" if final_tier < previous_tier else "↓"
            logger.info(f"Member {member_id}: {direction} Tier {previous_tier} → {final_tier} "
                      f"(KNN: {len(role_predictions)} datapoints, votes: {dict(final_vote_counts)})")
        
        return {
            'tier': final_tier,
            'previous_tier': previous_tier,
            'changed': changed,
            'total_crimes': member_data.get('total_crimes', 0),
            'requirements_met': 0,
            'requirements_needed': 0,
            'manual_override': False,
            'assignment_method': 'knn_prediction',
            'knn_num_datapoints': len(role_predictions),
            'knn_vote_counts': dict(final_vote_counts),
            'knn_prediction_details': prediction_details,
            'last_updated': datetime.now().isoformat()
        }
    
    def generate_tier_assignments(self) -> Dict:
        """
        Generate tier assignments using two-pass approach
        
        Pass 1: Assign based on available data, collect partial data members
        Pass 2: Use KNN for members with partial data
        
        Returns:
            Dictionary of member assignments
        """
        logger.info("="*60)
        logger.info("Generating Tier Assignments (Two-Pass with KNN)")
        logger.info(f"Proportion threshold: {self.proportion_threshold:.2%}")
        logger.info(f"KNN neighbors (k): {self.knn_k}")
        logger.info("="*60)
        
        all_assignments = {}
        self.knn_list = []
        self.members_no_data = []
        self.pass1_assignments = {}
        
        # PASS 1: Assign based on available data
        logger.info("\n--- PASS 1: Assigning with available data ---")
        
        for member_id, member_data in self.cpr_data.items():
            logger.debug(f"\nProcessing member {member_id}...")
            
            assignment = self.assign_tier_pass1(member_id, member_data)
            
            if assignment:
                all_assignments[member_id] = assignment
                self.pass1_assignments[member_id] = assignment
        
        logger.info(f"\nPass 1 complete:")
        logger.info(f"  Assigned: {len(self.pass1_assignments)} members")
        logger.info(f"  KNN list: {len(self.knn_list)} members (partial data)")
        logger.info(f"  No data: {len(self.members_no_data)} members")
        
        # PASS 2: KNN for partial data members
        if self.knn_list:
            logger.info(f"\n--- PASS 2: KNN for {len(self.knn_list)} members with partial data ---")
            
            for knn_member in self.knn_list:
                member_id = knn_member['member_id']
                member_data = knn_member['member_data']
                datapoints = knn_member['datapoints']
                
                logger.info(f"\nKNN for member {member_id} ({len(datapoints)} datapoints)...")
                
                assignment = self.assign_tier_knn(member_id, member_data, datapoints)
                all_assignments[member_id] = assignment
            
            logger.info(f"\nPass 2 complete: {len(all_assignments)} total assigned")
        
        # Summary statistics
        self.print_summary(all_assignments)
        
        return all_assignments
    
    def print_summary(self, assignments: Dict):
        """Print detailed summary statistics"""
        tier_counts = {-1: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0}
        changes = {'promoted': 0, 'demoted': 0, 'unchanged': 0}
        method_counts = {}
        
        for assignment in assignments.values():
            tier = assignment['tier']
            tier_counts[tier] = tier_counts.get(tier, 0) + 1
            
            method = assignment.get('assignment_method', 'unknown')
            method_counts[method] = method_counts.get(method, 0) + 1
            
            if assignment['changed']:
                if assignment['tier'] < assignment['previous_tier']:
                    changes['promoted'] += 1
                else:
                    changes['demoted'] += 1
            else:
                changes['unchanged'] += 1
        
        logger.info("\n" + "="*60)
        logger.info("Tier Assignment Summary")
        logger.info("="*60)
        logger.info(f"Total members: {len(self.cpr_data)}")
        logger.info(f"Assigned: {len(assignments)}")
        logger.info(f"No data: {len(self.members_no_data)}")
        
        logger.info(f"\nTier distribution:")
        if tier_counts[-1] > 0:
            logger.info(f"  ⚠️ Tier -1 (NEEDS MANUAL REVIEW): {tier_counts[-1]} members")
        for tier in range(1, 7):
            logger.info(f"  Tier {tier}: {tier_counts[tier]} members")
        
        logger.info(f"\nAssignment methods:")
        for method, count in sorted(method_counts.items()):
            logger.info(f"  {method.replace('_', ' ').title()}: {count}")
        
        logger.info(f"\nChanges:")
        logger.info(f"  Promoted: {changes['promoted']}")
        logger.info(f"  Demoted: {changes['demoted']}")
        logger.info(f"  Unchanged: {changes['unchanged']}")
        
        if self.members_no_data:
            logger.info(f"\n⚠ Members with no CPR data ({len(self.members_no_data)}):")
            for member_info in self.members_no_data[:5]:
                logger.info(f"  - {member_info['member_id']}")
            if len(self.members_no_data) > 5:
                logger.info(f"  ... and {len(self.members_no_data) - 5} more")
        
        logger.info("="*60)
    
    def save_tier_assignments(self, assignments: Dict):
        """Save tier assignments to member_tiers.json"""
        output_path = "data/member_tiers.json"
        logger.info(f"Saving tier assignments to {output_path}")
        
        # Convert to storage format
        simplified = {}
        for member_id, data in assignments.items():
            simplified[member_id] = {
                'tier': data['tier'],
                'previous_tier': data['previous_tier'],
                'last_updated': data.get('last_updated', datetime.now().isoformat()),
                'manual_override': data.get('manual_override', False),
                'total_crimes': data['total_crimes'],
                'requirements_met': data.get('requirements_met', 0),
                'requirements_needed': data.get('requirements_needed', 0),
                'assignment_method': data.get('assignment_method', 'unknown')
            }
            
            # Add method-specific fields
            if data.get('assignment_method') == 'knn_prediction':
                simplified[member_id]['knn_num_datapoints'] = data.get('knn_num_datapoints', 0)
                simplified[member_id]['knn_vote_counts'] = data.get('knn_vote_counts', {})
            
            if data.get('manual_override'):
                simplified[member_id]['override_reason'] = data.get('override_reason', '')
        
        with open(output_path, 'w') as f:
            json.dump(simplified, f, indent=2)
        
        logger.info(f"✓ Saved {len(simplified)} tier assignments")
        
        # Save detailed KNN predictions
        knn_members = [a for a in assignments.values() if a.get('assignment_method') == 'knn_prediction']
        if knn_members:
            knn_path = "data/knn_predictions.json"
            knn_details = []
            for member_id, data in assignments.items():
                if data.get('assignment_method') == 'knn_prediction':
                    knn_details.append({
                        'member_id': member_id,
                        'tier': data['tier'],
                        'previous_tier': data['previous_tier'],
                        'num_datapoints': data.get('knn_num_datapoints', 0),
                        'vote_counts': data.get('knn_vote_counts', {}),
                        'prediction_details': data.get('knn_prediction_details', [])
                    })
            
            with open(knn_path, 'w') as f:
                json.dump(knn_details, f, indent=2)
            logger.info(f"✓ Saved KNN predictions report: {len(knn_details)} members")
        
        # Save members with no data
        if self.members_no_data:
            no_data_path = "data/members_no_data.json"
            with open(no_data_path, 'w') as f:
                json.dump(self.members_no_data, f, indent=2)
            logger.info(f"✓ Saved no-data report: {len(self.members_no_data)} members")
    
    def update_google_sheets(self, assignments: Dict):
        """Write tier assignments to Google Sheets"""
        logger.info("Updating Google Sheets with tier assignments...")
        
        try:
            sheets = GoogleSheetsManager()
            
            # Update member tier data
            sheets.update_member_tier_data(assignments)
            
            # Write tier history for changed tiers
            changes = []
            for member_id, data in assignments.items():
                if data.get('changed'):
                    method = data.get('assignment_method', 'unknown')
                    
                    if method == 'knn_prediction':
                        votes = data.get('knn_vote_counts', {})
                        reason = f"KNN prediction ({data.get('knn_num_datapoints', 0)} datapoints, votes: {votes})"
                    elif method == 'pass1_requirements':
                        reason = f"Requirements met ({data.get('requirements_met', 0)}/{data.get('requirements_needed', 0)})"
                    elif method == 'manual_override':
                        reason = data.get('override_reason', 'Manual override')
                    else:
                        reason = method.replace('_', ' ').title()
                    
                    changes.append({
                        'member_id': int(member_id),
                        'date': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                        'old_tier': data['previous_tier'],
                        'new_tier': data['tier'],
                        'score': 0.0,  # Legacy field
                        'reason': reason
                    })
            
            if changes:
                sheets.write_tier_history(changes)
            
            logger.info("✓ Google Sheets updated successfully")
            
        except Exception as e:
            logger.error(f"Error updating Google Sheets: {e}")
            raise


def main():
    """Main execution"""
    logger.info("Starting Tier Assignment System (Proportion-Based + KNN)")
    
    try:
        # Initialize tier assignment with 2/3 proportion threshold
        tier_system = TierAssignment(proportion_threshold=2/3, knn_k=5)
        
        # Generate assignments
        assignments = tier_system.generate_tier_assignments()
        
        # Save to JSON
        tier_system.save_tier_assignments(assignments)
        
        # Update Google Sheets
        tier_system.update_google_sheets(assignments)
        
        logger.info("\n✓ Tier assignment completed successfully!")
        
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()