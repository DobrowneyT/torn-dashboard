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
            (6, "Muscle", 75),
            ("avg", 5, 75),  # Average of all Level 5 roles >= 75
            ("avg", 4, 75)   # Average of all Level 4 roles >= 75
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
        - Check tiers 1-4 top-down
        - If 0 data points for tier → check next tier
        - If meets threshold with available data → assign tier
        - If has >0 but <threshold data points → add to KNN list, check next tier
        - If checked all tiers 1-4 without assignment → assign tier 5
        
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
            # No CPR data at all
            self.members_no_data.append({
                'member_id': member_id,
                'reason': 'No CPR data available',
                'total_crimes': member_data.get('total_crimes', 0)
            })
            logger.warning(f"Member {member_id}: No CPR data - cannot assign")
            return None
        
        # Track if member has partial data for any tier
        has_partial_data = False
        
        # Check tiers 1-4 top-down
        for tier in range(1, 5):
            status = self.check_tier_requirements(member_id, member_data, tier)
            
            if status['data_points_available'] == 0:
                # No data for this tier, move to next
                logger.debug(f"Member {member_id} Tier {tier}: 0 data points, checking next tier")
                continue
            
            if status['meets_threshold']:
                # Assign this tier immediately
                previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 5)
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
                # Has some data but doesn't meet threshold
                has_partial_data = True
                logger.debug(f"Member {member_id} Tier {tier}: Partial data "
                           f"({status['requirements_met']}/{status['requirements_needed']}, "
                           f"{status['data_points_available']} available)")
        
        # If we get here, member didn't qualify for tiers 1-4
        if has_partial_data:
            # Add to KNN list for second pass
            self.knn_list.append({
                'member_id': member_id,
                'member_data': member_data,
                'datapoints': all_datapoints
            })
            logger.info(f"Member {member_id}: Partial data, added to KNN list ({len(all_datapoints)} datapoints)")
            return None
        else:
            # Has data but doesn't qualify for any tier 1-4 → Tier 5
            previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 5)
            changed = 5 != previous_tier
            
            logger.info(f"Member {member_id}: No tier 1-4 qualification → Tier 5")
            
            return {
                'tier': 5,
                'previous_tier': previous_tier,
                'changed': changed,
                'total_crimes': member_data.get('total_crimes', 0),
                'requirements_met': 0,
                'requirements_needed': 0,
                'manual_override': False,
                'assignment_method': 'pass1_default_tier5',
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
            # Could not make any predictions - default to Tier 5
            logger.warning(f"Member {member_id}: KNN failed (not enough neighbors) → Tier 5")
            
            previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 5)
            
            return {
                'tier': 5,
                'previous_tier': previous_tier,
                'changed': 5 != previous_tier,
                'total_crimes': member_data.get('total_crimes', 0),
                'requirements_met': 0,
                'requirements_needed': 0,
                'manual_override': False,
                'assignment_method': 'knn_failed_default_tier5',
                'last_updated': datetime.now().isoformat()
            }
        
        # Final majority vote across all role predictions
        final_vote_counts = Counter(role_predictions)
        
        # In case of tie, choose lower (better) tier
        max_votes = max(final_vote_counts.values())
        tied_tiers = [tier for tier, votes in final_vote_counts.items() if votes == max_votes]
        final_tier = min(tied_tiers)
        
        previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 5)
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
        tier_counts = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
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
        for tier in range(1, 6):
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



# """
# Tier Assignment Script
# Automatically assigns member tiers based on CPR performance data
# Uses proportion-based evaluation with top-down tier checking and KNN predictions
# """

# import json
# import logging
# import sys
# from pathlib import Path
# from datetime import datetime
# from typing import Dict, List, Tuple, Optional
# import math
# from collections import Counter

# # Add parent directory to path for imports
# sys.path.insert(0, str(Path(__file__).parent.parent))

# from scripts.utils.google_sheets import GoogleSheetsManager

# logging.basicConfig(
#     level=logging.INFO,
#     format='%(asctime)s - %(levelname)s - %(message)s'
# )
# logger = logging.getLogger(__name__)


# class TierAssignment:
#     """Handles automatic tier assignment based on CPR data"""
    
#     # Tier requirements: each tier has list of (level, role, min_cpr) tuples
#     # For averages, use ("avg", level, min_cpr)
#     TIER_REQUIREMENTS = {
#         1: [
#             (8, "Imitator", 70),
#             (8, "Muscle", 65),
#             (8, "Thief", 65)
#         ],
#         2: [
#             (8, "Muscle", 60),
#             (8, "Robber", 60),
#             (8, "Assassin", 67),
#             (8, "Cat Burglar", 67),
#             (8, "Cleaner", 67),
#             (7, "Muscle", 75),
#             (7, "Engineer", 75),
#             (7, "Bomber", 75)
#         ],
#         3: [
#             (7, "Hacker", 70),
#             (7, "Picklock", 70),
#             (6, "Bomber", 75),
#             (6, "Driver", 75),
#             (6, "Robber", 75)
#         ],
#         4: [
#             (6, "Bomber", 70),
#             (6, "Robber", 70),
#             (6, "Enforcer", 75),
#             (6, "Muscle", 75),
#             ("avg", 5, 75),  # Average of all Level 5 roles >= 75
#             ("avg", 4, 75)   # Average of all Level 4 roles >= 75
#         ]
#     }
    
#     def __init__(self, proportion_threshold: float = 2/3, knn_k: int = 5):
#         """
#         Initialize tier assignment system
        
#         Args:
#             proportion_threshold: Proportion of requirements that must be met (default: 2/3)
#             knn_k: Number of neighbors for KNN prediction (default: 5)
#         """
#         self.proportion_threshold = proportion_threshold
#         self.knn_k = knn_k
#         self.cpr_data = self.load_cpr_data()
#         self.existing_tiers = self.load_existing_tiers()
#         self.members_missing_data = []
#         self.knn_predictions = []
        
#         # Pre-calculate requirements needed for each tier
#         self.tier_requirements_needed = {
#             tier: math.ceil(len(reqs) * self.proportion_threshold)
#             for tier, reqs in self.TIER_REQUIREMENTS.items()
#         }
        
#         logger.info(f"Tier requirements (need to meet):")
#         for tier in sorted(self.TIER_REQUIREMENTS.keys()):
#             total = len(self.TIER_REQUIREMENTS[tier])
#             needed = self.tier_requirements_needed[tier]
#             logger.info(f"  Tier {tier}: {needed}/{total} requirements")
    
#     def load_cpr_data(self) -> Dict:
#         """Load CPR database"""
#         path = "data/cpr_database.json"
#         logger.info(f"Loading CPR data from {path}")
#         try:
#             with open(path, 'r') as f:
#                 data = json.load(f)
            
#             # Extract data from 'members' if nested
#             if 'members' in data:
#                 members = data['members']
#             else:
#                 members = data
            
#             logger.info(f"✓ Loaded CPR data for {len(members)} members")
#             return members
#         except FileNotFoundError:
#             logger.warning(f"CPR database not found: {path}")
#             return {}
#         except json.JSONDecodeError as e:
#             logger.error(f"Invalid JSON in CPR database: {e}")
#             return {}
    
#     def load_existing_tiers(self) -> Dict:
#         """Load existing tier assignments"""
#         path = "data/member_tiers.json"
#         logger.info(f"Loading existing tiers from {path}")
#         try:
#             with open(path, 'r') as f:
#                 data = json.load(f)
#             logger.info(f"✓ Loaded existing tiers for {len(data)} members")
#             return data
#         except FileNotFoundError:
#             logger.warning(f"Tier file not found: {path}, will create new")
#             return {}
#         except json.JSONDecodeError as e:
#             logger.error(f"Invalid JSON in tier file: {e}")
#             return {}
    
#     def get_cpr_value(self, member_data: Dict, level: int, role: str) -> Optional[float]:
#         """
#         Get CPR value for a specific level and role
        
#         Returns:
#             CPR value or None if not available
#         """
#         # Try both 'cpr_by_role' and 'cpr_by_difficulty' keys for compatibility
#         cpr_data = member_data.get('cpr_by_role') or member_data.get('cpr_by_difficulty', {})
        
#         # Level can be stored as string number or "Level X" format
#         level_key = str(level)
#         if level_key not in cpr_data:
#             level_key = f"Level {level}"
#             if level_key not in cpr_data:
#                 return None
        
#         level_data = cpr_data[level_key]
#         return level_data.get(role)
    
#     def calculate_level_average(self, member_data: Dict, level: int) -> Optional[float]:
#         """
#         Calculate average CPR across all roles for a given level
        
#         Returns:
#             Average CPR or None if no data available
#         """
#         # Try both 'cpr_by_role' and 'cpr_by_difficulty' keys for compatibility
#         cpr_data = member_data.get('cpr_by_role') or member_data.get('cpr_by_difficulty', {})
        
#         # Level can be stored as string number or "Level X" format
#         level_key = str(level)
#         if level_key not in cpr_data:
#             level_key = f"Level {level}"
#             if level_key not in cpr_data:
#                 return None
        
#         level_data = cpr_data[level_key]
#         cpr_values = [v for v in level_data.values() if isinstance(v, (int, float))]
        
#         if not cpr_values:
#             return None
        
#         return sum(cpr_values) / len(cpr_values)
    
#     def evaluate_requirement(self, member_data: Dict, requirement: Tuple) -> Tuple[bool, bool]:
#         """
#         Evaluate a single requirement for a member
        
#         Args:
#             member_data: Member's CPR data
#             requirement: (level, role, min_cpr) or ("avg", level, min_cpr)
        
#         Returns:
#             (requirement_met, data_available)
#         """
#         if requirement[0] == "avg":
#             # Average requirement
#             _, level, min_cpr = requirement
#             avg_cpr = self.calculate_level_average(member_data, level)
            
#             if avg_cpr is None:
#                 return False, False
            
#             return avg_cpr >= min_cpr, True
#         else:
#             # Specific role requirement
#             level, role, min_cpr = requirement
#             cpr_value = self.get_cpr_value(member_data, level, role)
            
#             if cpr_value is None:
#                 return False, False
            
#             return cpr_value >= min_cpr, True
    
#     def check_tier_eligibility(self, member_id: str, member_data: Dict, tier: int) -> Tuple[bool, int, int, List[str], List[Tuple]]:
#         """
#         Check if member meets requirements for a specific tier
        
#         Args:
#             member_id: Member ID
#             member_data: Member's CPR data
#             tier: Tier number to check
        
#         Returns:
#             (eligible, requirements_met, requirements_needed, missing_data_roles, requirements_with_data)
#         """
#         requirements = self.TIER_REQUIREMENTS[tier]
#         requirements_needed = self.tier_requirements_needed[tier]
        
#         requirements_met = 0
#         requirements_failed = 0
#         missing_data_roles = []
#         requirements_with_data = []  # Track requirements where we have data
        
#         for req in requirements:
#             met, data_available = self.evaluate_requirement(member_data, req)
            
#             if data_available:
#                 requirements_with_data.append(req)
#                 if met:
#                     requirements_met += 1
#                 else:
#                     requirements_failed += 1
#             else:
#                 # Track missing data
#                 if req[0] == "avg":
#                     missing_data_roles.append((req, f"Level {req[1]} Average"))
#                 else:
#                     missing_data_roles.append((req, f"Level {req[0]} {req[1]}"))
        
#         eligible = requirements_met >= requirements_needed
        
#         logger.debug(f"Member {member_id} Tier {tier}: {requirements_met}/{requirements_needed} requirements met, "
#                     f"{requirements_failed} failed, {len(missing_data_roles)} missing")
        
#         return eligible, requirements_met, requirements_needed, missing_data_roles, requirements_with_data
    
#     def has_sufficient_data(self, member_data: Dict, tier: int) -> Tuple[bool, List[str]]:
#         """
#         Check if member has enough data to evaluate for a tier
        
#         Returns:
#             (has_sufficient_data, missing_roles)
#         """
#         requirements = self.TIER_REQUIREMENTS[tier]
#         requirements_needed = self.tier_requirements_needed[tier]
#         missing_roles = []
#         available_count = 0
        
#         for req in requirements:
#             _, data_available = self.evaluate_requirement(member_data, req)
#             if data_available:
#                 available_count += 1
#             else:
#                 if req[0] == "avg":
#                     missing_roles.append(f"Level {req[1]} Average")
#                 else:
#                     missing_roles.append(f"Level {req[0]} {req[1]}")
        
#         # Need at least enough data to potentially meet the threshold
#         has_sufficient = available_count >= requirements_needed
        
#         return has_sufficient, missing_roles
    
#     def get_member_cpr_profile(self, member_data: Dict) -> List[Tuple[str, str, float]]:
#         """
#         Extract all available CPR data points for a member
        
#         Returns:
#             List of (level_key, role, cpr_value) tuples, sorted by CPR descending
#         """
#         # Try both 'cpr_by_role' and 'cpr_by_difficulty' keys for compatibility
#         cpr_data = member_data.get('cpr_by_role') or member_data.get('cpr_by_difficulty', {})
#         cpr_points = []
        
#         for level_key, roles in cpr_data.items():
#             # Normalize level_key to "Level X" format for consistency
#             if not level_key.startswith("Level"):
#                 normalized_level_key = f"Level {level_key}"
#             else:
#                 normalized_level_key = level_key
                
#             for role, cpr in roles.items():
#                 if isinstance(cpr, (int, float)):
#                     cpr_points.append((normalized_level_key, role, cpr))
        
#         # Sort by CPR value descending (best performance first)
#         return sorted(cpr_points, key=lambda x: x[2], reverse=True)
    
#     def predict_tier_for_missing_requirement(self, member_id: str, member_data: Dict, requirement: Tuple, tier: int) -> Optional[int]:
#         """
#         Predict if member would meet a specific requirement using KNN
        
#         Args:
#             member_id: Member ID
#             member_data: Member's CPR data
#             requirement: The requirement tuple to predict for
#             tier: The tier being evaluated
        
#         Returns:
#             Predicted tier for members with similar profiles, or None if cannot predict
#         """
#         # Get the member's available CPR data that we do have
#         member_profile = self.get_member_cpr_profile(member_data)
        
#         if not member_profile:
#             return None
        
#         # Find members with similar CPR profiles who have the missing requirement data
#         predictions_from_roles = []
        
#         # Use the member's available roles to find similar members
#         for level_key, role, member_cpr in member_profile[:5]:  # Use top 5 available roles
#             neighbors = []
#             level_num = int(level_key.split()[1])
            
#             # Find members with data for this role AND the missing requirement
#             for other_id, other_data in self.cpr_data.items():
#                 if other_id == member_id:
#                     continue
                
#                 # Must have tier assignment
#                 if other_id not in self.existing_tiers:
#                     continue
                
#                 # Must have data for the role we're comparing on
#                 other_cpr = self.get_cpr_value(other_data, level_num, role)
#                 if other_cpr is None:
#                     continue
                
#                 # Must have data for the missing requirement we're trying to predict
#                 _, has_requirement_data = self.evaluate_requirement(other_data, requirement)
#                 if not has_requirement_data:
#                     continue
                
#                 # Calculate distance and get their tier
#                 distance = abs(member_cpr - other_cpr)
#                 other_tier = self.existing_tiers[other_id]['tier']
                
#                 neighbors.append((distance, other_tier, other_id))
            
#             # Need at least k neighbors for this role
#             if len(neighbors) >= self.knn_k:
#                 nearest = sorted(neighbors, key=lambda x: x[0])[:self.knn_k]
#                 tier_votes = [n[1] for n in nearest]
                
#                 # Get most common tier from neighbors
#                 vote_counts = Counter(tier_votes)
#                 predicted_tier = vote_counts.most_common(1)[0][0]
#                 predictions_from_roles.append(predicted_tier)
                
#                 logger.debug(f"Member {member_id}, {level_key} {role}: KNN predicts neighbors are in tiers {tier_votes}")
        
#         if not predictions_from_roles:
#             return None
        
#         # If all predictions agree, return that tier
#         if len(set(predictions_from_roles)) == 1:
#             return predictions_from_roles[0]
        
#         # If predictions differ, return the lower (more conservative) tier
#         return min(predictions_from_roles)
    
#     def check_tier_with_knn(self, member_id: str, member_data: Dict, tier: int) -> Tuple[bool, int, int, List[str], str]:
#         """
#         Check tier eligibility with KNN prediction for missing data points
        
#         Args:
#             member_id: Member ID
#             member_data: Member's CPR data
#             tier: Tier to check
        
#         Returns:
#             (eligible, requirements_met, requirements_needed, missing_roles, decision_reason)
#         """
#         eligible, met, needed, missing, reqs_with_data = self.check_tier_eligibility(
#             member_id, member_data, tier
#         )
        
#         # If already eligible or definitely not eligible, return immediately
#         if eligible:
#             return True, met, needed, [m[1] for m in missing], "requirements_met"
        
#         # Check if they could potentially reach the threshold with missing data
#         # Can they still reach the threshold even if all missing requirements fail?
#         total_requirements = len(self.TIER_REQUIREMENTS[tier])
#         requirements_failed = len(reqs_with_data) - met
#         max_possible = met + len(missing)
        
#         # Definitely cannot reach threshold
#         if max_possible < needed:
#             return False, met, needed, [m[1] for m in missing], "insufficient_possible"
        
#         # If we have no missing data, they simply didn't meet the requirements
#         if not missing:
#             return False, met, needed, [], "requirements_not_met"
        
#         # Use KNN to predict if they would meet missing requirements
#         logger.info(f"Member {member_id} Tier {tier}: Using KNN to predict {len(missing)} missing requirement(s)")
        
#         knn_predicted_met = 0
#         knn_predictions_used = []
        
#         for req, req_description in missing:
#             predicted_tier = self.predict_tier_for_missing_requirement(
#                 member_id, member_data, req, tier
#             )
            
#             if predicted_tier is not None:
#                 # If KNN predicts they're in this tier or better, assume they'd meet this requirement
#                 if predicted_tier <= tier:
#                     knn_predicted_met += 1
#                     knn_predictions_used.append((req_description, predicted_tier, "would_meet"))
#                     logger.debug(f"  KNN predicts {req_description}: Would meet (neighbors in Tier {predicted_tier})")
#                 else:
#                     knn_predictions_used.append((req_description, predicted_tier, "would_not_meet"))
#                     logger.debug(f"  KNN predicts {req_description}: Would not meet (neighbors in Tier {predicted_tier})")
#             else:
#                 logger.debug(f"  KNN could not predict for {req_description}")
        
#         # Total met = actual met + KNN predicted met
#         total_met_with_knn = met + knn_predicted_met
        
#         if total_met_with_knn >= needed:
#             logger.info(f"Member {member_id} Tier {tier}: Eligible with KNN predictions ({total_met_with_knn}/{needed})")
#             return True, total_met_with_knn, needed, [m[1] for m in missing], f"knn_prediction_{len(knn_predictions_used)}_requirements"
#         else:
#             return False, total_met_with_knn, needed, [m[1] for m in missing], "knn_prediction_insufficient"
    
#     def predict_tier_knn(self, member_id: str, member_data: Dict) -> Optional[Dict]:
#         """
#         Predict tier using K-Nearest Neighbors based on available CPR data
        
#         Uses top CPR values from member and finds nearest neighbors with existing tiers
#         Performs majority voting across multiple predictions for robustness
        
#         Args:
#             member_id: Member ID to predict for
#             member_data: Member's CPR data
        
#         Returns:
#             Prediction dict with tier and confidence info, or None if cannot predict
#         """
#         # Get member's CPR profile
#         member_cpr_profile = self.get_member_cpr_profile(member_data)
        
#         if not member_cpr_profile:
#             logger.warning(f"Member {member_id}: No CPR data available for KNN")
#             return None
        
#         # Use top CPR values (up to 5, or all if less)
#         top_cpr_points = member_cpr_profile[:min(5, len(member_cpr_profile))]
        
#         tier_predictions = []
#         prediction_details = []
        
#         # For each of the member's top CPR points, find nearest neighbors
#         for level_key, role, member_cpr in top_cpr_points:
#             neighbors = []
#             level_num = int(level_key.split()[1])
            
#             # Find all members with tier assignments and data for the same level/role
#             for other_id, other_data in self.cpr_data.items():
#                 if other_id == member_id:
#                     continue
                
#                 # Skip members without tier assignments
#                 if other_id not in self.existing_tiers:
#                     continue
                
#                 # Get their CPR for this same role/level
#                 other_cpr = self.get_cpr_value(other_data, level_num, role)
                
#                 if other_cpr is not None:
#                     distance = abs(member_cpr - other_cpr)
#                     tier = self.existing_tiers[other_id]['tier']
#                     neighbors.append((distance, tier, other_id, other_cpr))
            
#             # Need at least k neighbors for this prediction
#             if len(neighbors) >= self.knn_k:
#                 # Sort by distance and take k nearest
#                 nearest = sorted(neighbors, key=lambda x: x[0])[:self.knn_k]
#                 tier_votes = [n[1] for n in nearest]
                
#                 # Majority vote for this role
#                 vote_counts = Counter(tier_votes)
#                 predicted_tier = vote_counts.most_common(1)[0][0]
#                 confidence = vote_counts[predicted_tier] / self.knn_k
                
#                 tier_predictions.append(predicted_tier)
#                 prediction_details.append({
#                     'role': f"{level_key} {role}",
#                     'member_cpr': member_cpr,
#                     'predicted_tier': predicted_tier,
#                     'confidence': confidence,
#                     'votes': dict(vote_counts),
#                     'nearest_neighbors': [
#                         {'id': n[2], 'cpr': n[3], 'tier': n[1], 'distance': n[0]}
#                         for n in nearest
#                     ]
#                 })
                
#                 logger.debug(f"Member {member_id}, {level_key} {role} (CPR={member_cpr:.1f}): "
#                            f"KNN predicted Tier {predicted_tier} (confidence: {confidence:.1%})")
        
#         # Need at least one successful prediction
#         if not tier_predictions:
#             logger.warning(f"Member {member_id}: Could not find enough neighbors for KNN prediction")
#             return None
        
#         # Final prediction: majority vote across all role predictions
#         final_vote_counts = Counter(tier_predictions)
#         final_tier = final_vote_counts.most_common(1)[0][0]
#         final_confidence = final_vote_counts[final_tier] / len(tier_predictions)
        
#         # Calculate consensus (all predictions agree)
#         consensus = len(set(tier_predictions)) == 1
        
#         logger.info(f"Member {member_id}: KNN prediction = Tier {final_tier} "
#                    f"(confidence: {final_confidence:.1%}, consensus: {consensus}, "
#                    f"votes: {dict(final_vote_counts)})")
        
#         return {
#             'predicted_tier': final_tier,
#             'confidence': final_confidence,
#             'consensus': consensus,
#             'vote_counts': dict(final_vote_counts),
#             'num_predictions': len(tier_predictions),
#             'prediction_details': prediction_details
#         }
    
#     def assign_member_tier(self, member_id: str, member_data: Dict, use_knn: bool = False) -> Optional[Dict]:
#         """
#         Assign tier to a member using top-down approach
        
#         Args:
#             member_id: Member ID
#             member_data: Member's CPR data
#             use_knn: Whether to use KNN for missing data (second pass)
        
#         Returns:
#             Assignment data dict or None if cannot assign
#         """
#         # Check for manual override
#         if member_id in self.existing_tiers:
#             existing = self.existing_tiers[member_id]
#             if existing.get('manual_override', False):
#                 logger.info(f"Member {member_id} has manual override: Tier {existing['tier']}")
#                 return {
#                     'tier': existing['tier'],
#                     'score': existing.get('score', 0.0),
#                     'previous_tier': existing.get('tier'),
#                     'changed': False,
#                     'manual_override': True,
#                     'override_reason': existing.get('override_reason', 'Manual assignment'),
#                     'total_crimes': member_data.get('total_crimes', 0),
#                     'evaluated_roles': [],
#                     'requirements_met': 0,
#                     'requirements_needed': 0,
#                     'assignment_method': 'manual_override'
#                 }
        
#         # Top-down tier checking (1 through 4)
#         for tier in range(1, 5):
#             if use_knn:
#                 # Second pass: Use KNN for missing requirements
#                 eligible, met, needed, missing_roles, decision_reason = self.check_tier_with_knn(
#                     member_id, member_data, tier
#                 )
#             else:
#                 # First pass: Only use actual data
#                 eligible, met, needed, missing_roles, reqs_with_data = self.check_tier_eligibility(
#                     member_id, member_data, tier
#                 )
#                 decision_reason = 'requirements_met' if eligible else 'requirements_not_met'
            
#             if eligible:
#                 previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 5)
#                 changed = tier != previous_tier
                
#                 if changed:
#                     direction = "↑ Promoted" if tier < previous_tier else "↓ Demoted"
#                     logger.info(f"Member {member_id}: {direction} from Tier {previous_tier} to Tier {tier} "
#                               f"({met}/{needed}, method: {decision_reason})")
                
#                 # Track if KNN was used
#                 used_knn = use_knn and "knn" in decision_reason
#                 if used_knn:
#                     self.knn_predictions.append({
#                         'member_id': member_id,
#                         'tier': tier,
#                         'method': decision_reason,
#                         'requirements_met': met,
#                         'requirements_needed': needed,
#                         'missing_roles': missing_roles
#                     })
                
#                 return {
#                     'tier': tier,
#                     'score': 0.0,  # Legacy field
#                     'previous_tier': previous_tier,
#                     'changed': changed,
#                     'total_crimes': member_data.get('total_crimes', 0),
#                     'evaluated_roles': [],
#                     'requirements_met': met,
#                     'requirements_needed': needed,
#                     'manual_override': False,
#                     'last_updated': datetime.now().isoformat(),
#                     'assignment_method': decision_reason,
#                     'used_knn': used_knn
#                 }
        
#         # Did not qualify for Tiers 1-4 based on requirements
#         # Check if member has ANY CPR data
#         member_cpr_profile = self.get_member_cpr_profile(member_data)
        
#         if not member_cpr_profile:
#             # No data at all - cannot assign even with KNN
#             self.members_missing_data.append({
#                 'member_id': member_id,
#                 'reason': 'No CPR data available',
#                 'total_crimes': member_data.get('total_crimes', 0)
#             })
#             logger.warning(f"Member {member_id}: No CPR data - cannot assign tier")
#             return None
        
#         # Has some data but didn't meet requirements for Tiers 1-4
#         # Try KNN prediction before defaulting to Tier 5
#         logger.info(f"Member {member_id}: Did not meet Tier 1-4 requirements, attempting KNN prediction...")
        
#         knn_result = self.predict_tier_knn(member_id, member_data)
        
#         if knn_result and knn_result['confidence'] >= 0.6:  # Require 60% confidence
#             # Use KNN prediction
#             predicted_tier = knn_result['predicted_tier']
#             previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 5)
#             changed = predicted_tier != previous_tier
            
#             if changed:
#                 direction = "↑ Promoted" if predicted_tier < previous_tier else "↓ Demoted"
#                 logger.info(f"Member {member_id}: {direction} from Tier {previous_tier} to Tier {predicted_tier} "
#                           f"(KNN prediction, confidence: {knn_result['confidence']:.1%})")
            
#             # Log this KNN prediction for review
#             self.knn_predictions.append({
#                 'member_id': member_id,
#                 'predicted_tier': predicted_tier,
#                 'confidence': knn_result['confidence'],
#                 'consensus': knn_result['consensus'],
#                 'num_data_points': len(member_cpr_profile)
#             })
            
#             return {
#                 'tier': predicted_tier,
#                 'score': 0.0,
#                 'previous_tier': previous_tier,
#                 'changed': changed,
#                 'total_crimes': member_data.get('total_crimes', 0),
#                 'evaluated_roles': [],
#                 'requirements_met': 0,
#                 'requirements_needed': 0,
#                 'manual_override': False,
#                 'last_updated': datetime.now().isoformat(),
#                 'assignment_method': 'knn_prediction',
#                 'knn_confidence': knn_result['confidence'],
#                 'knn_consensus': knn_result['consensus']
#             }
#         else:
#             # KNN failed or low confidence - default to Tier 5
#             previous_tier = self.existing_tiers.get(member_id, {}).get('tier', 5)
#             changed = 5 != previous_tier
            
#             reason = 'KNN prediction low confidence' if knn_result else 'KNN prediction failed'
#             logger.info(f"Member {member_id}: Assigned to Tier 5 ({reason})")
            
#             self.members_missing_data.append({
#                 'member_id': member_id,
#                 'reason': reason,
#                 'total_crimes': member_data.get('total_crimes', 0),
#                 'knn_attempted': knn_result is not None,
#                 'knn_confidence': knn_result['confidence'] if knn_result else 0.0
#             })
            
#             return {
#                 'tier': 5,
#                 'score': 0.0,
#                 'previous_tier': previous_tier,
#                 'changed': changed,
#                 'total_crimes': member_data.get('total_crimes', 0),
#                 'evaluated_roles': [],
#                 'requirements_met': 0,
#                 'requirements_needed': 0,
#                 'manual_override': False,
#                 'last_updated': datetime.now().isoformat(),
#                 'assignment_method': 'default_tier_5'
#             }
    
#     def generate_tier_assignments(self) -> Dict:
#         """
#         Generate tier assignments for all members using two-pass approach
        
#         Pass 1: Assign tiers based only on available data
#         Pass 2: Use KNN for members who were skipped due to missing data
        
#         Returns:
#             Dictionary of member assignments with metadata
#         """
#         logger.info("="*60)
#         logger.info("Generating Tier Assignments (Two-Pass with KNN)")
#         logger.info(f"Proportion threshold: {self.proportion_threshold:.2%}")
#         logger.info(f"KNN neighbors (k): {self.knn_k}")
#         logger.info("="*60)
        
#         assignments = {}
#         skipped_members = []
#         self.members_missing_data = []
#         self.knn_predictions = []
        
#         # PASS 1: Assign tiers using only available data
#         logger.info("\n--- PASS 1: Assigning tiers with available data ---")
#         for member_id, member_data in self.cpr_data.items():
#             logger.debug(f"\nProcessing member {member_id}...")
            
#             assignment = self.assign_member_tier(member_id, member_data, use_knn=False)
            
#             if assignment:
#                 assignments[member_id] = assignment
#             else:
#                 # Skip for now - will try KNN in pass 2
#                 skipped_members.append(member_id)
#                 logger.debug(f"Member {member_id}: Skipped (insufficient data for Pass 1)")
        
#         logger.info(f"\nPass 1 complete: {len(assignments)} assigned, {len(skipped_members)} skipped")
        
#         # PASS 2: Try KNN for skipped members
#         if skipped_members:
#             logger.info(f"\n--- PASS 2: Using KNN for {len(skipped_members)} skipped members ---")
            
#             for member_id in skipped_members:
#                 member_data = self.cpr_data[member_id]
#                 logger.debug(f"\nRetrying member {member_id} with KNN...")
                
#                 assignment = self.assign_member_tier(member_id, member_data, use_knn=True)
                
#                 if assignment:
#                     assignments[member_id] = assignment
#                     logger.info(f"Member {member_id}: Successfully assigned using KNN")
#                 else:
#                     # Still couldn't assign even with KNN
#                     logger.warning(f"Member {member_id}: Could not assign even with KNN")
#                     self.members_missing_data.append({
#                         'member_id': member_id,
#                         'reason': 'Insufficient data even with KNN',
#                         'total_crimes': member_data.get('total_crimes', 0)
#                     })
            
#             logger.info(f"\nPass 2 complete: {len(assignments)} total assigned, "
#                        f"{len(self.members_missing_data)} still unassigned")
        
#         # Summary statistics
#         tier_counts = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
#         changes = {'promoted': 0, 'demoted': 0, 'unchanged': 0}
#         method_counts = {}
#         knn_usage_count = 0
        
#         for assignment in assignments.values():
#             tier = assignment['tier']
#             tier_counts[tier] = tier_counts.get(tier, 0) + 1
            
#             method = assignment.get('assignment_method', 'unknown')
#             method_counts[method] = method_counts.get(method, 0) + 1
            
#             if assignment.get('used_knn', False):
#                 knn_usage_count += 1
            
#             if assignment['changed']:
#                 if assignment['tier'] < assignment['previous_tier']:
#                     changes['promoted'] += 1
#                 else:
#                     changes['demoted'] += 1
#             else:
#                 changes['unchanged'] += 1
        
#         logger.info("\n" + "="*60)
#         logger.info("Tier Assignment Summary")
#         logger.info("="*60)
#         logger.info(f"Total members evaluated: {len(assignments)}")
#         logger.info(f"Members skipped (no data): {len([m for m in self.members_missing_data if 'No CPR data' in m['reason']])}")
#         logger.info(f"KNN used for missing requirements: {knn_usage_count} members")
#         logger.info(f"\nTier distribution:")
#         for tier in range(1, 6):
#             logger.info(f"  Tier {tier}: {tier_counts[tier]} members")
#         logger.info(f"\nAssignment methods:")
#         for method, count in sorted(method_counts.items()):
#             logger.info(f"  {method.replace('_', ' ').title()}: {count}")
#         logger.info(f"\nChanges:")
#         logger.info(f"  Promoted: {changes['promoted']}")
#         logger.info(f"  Demoted: {changes['demoted']}")
#         logger.info(f"  Unchanged: {changes['unchanged']}")
        
#         if self.knn_predictions:
#             logger.info(f"\n⚠ KNN Used for Missing Requirements ({len(self.knn_predictions)} cases):")
#             for pred in self.knn_predictions[:10]:  # Show first 10
#                 logger.info(f"  - Member {pred['member_id']}: Tier {pred['tier']} "
#                           f"({pred['requirements_met']}/{pred['requirements_needed']}, "
#                           f"missing: {len(pred.get('missing_roles', []))} roles)")
#             if len(self.knn_predictions) > 10:
#                 logger.info(f"  ... and {len(self.knn_predictions) - 10} more (see knn_predictions.json)")
        
#         if self.members_missing_data:
#             no_data = [m for m in self.members_missing_data if 'No CPR data' in m['reason']]
#             if no_data:
#                 logger.info(f"\n⚠ Members with no CPR data ({len(no_data)}):")
#                 for member_info in no_data[:10]:
#                     logger.info(f"  - Member {member_info['member_id']}")
#                 if len(no_data) > 10:
#                     logger.info(f"  ... and {len(no_data) - 10} more")
        
#         logger.info("="*60)
        
#         return assignments
    
#     def save_tier_assignments(self, assignments: Dict):
#         """Save tier assignments to member_tiers.json"""
#         output_path = "data/member_tiers.json"
#         logger.info(f"Saving tier assignments to {output_path}")
        
#         # Convert to simpler format for storage
#         simplified = {}
#         for member_id, data in assignments.items():
#             simplified[member_id] = {
#                 'tier': data['tier'],
#                 'score': data.get('score', 0.0),
#                 'previous_tier': data['previous_tier'],
#                 'last_updated': data.get('last_updated', datetime.now().isoformat()),
#                 'manual_override': data.get('manual_override', False),
#                 'total_crimes': data['total_crimes'],
#                 'requirements_met': data.get('requirements_met', 0),
#                 'requirements_needed': data.get('requirements_needed', 0),
#                 'assignment_method': data.get('assignment_method', 'unknown')
#             }
            
#             # Add KNN-specific fields if applicable
#             if data.get('assignment_method') == 'knn_prediction':
#                 simplified[member_id]['knn_confidence'] = data.get('knn_confidence', 0.0)
#                 simplified[member_id]['knn_consensus'] = data.get('knn_consensus', False)
            
#             if data.get('manual_override'):
#                 simplified[member_id]['override_reason'] = data.get('override_reason', '')
        
#         with open(output_path, 'w') as f:
#             json.dump(simplified, f, indent=2)
        
#         logger.info(f"✓ Saved {len(simplified)} tier assignments")
        
#         # Save KNN predictions report
#         if self.knn_predictions:
#             knn_path = "data/knn_predictions.json"
#             with open(knn_path, 'w') as f:
#                 json.dump(self.knn_predictions, f, indent=2)
#             logger.info(f"✓ Saved KNN predictions report to {knn_path}")
        
#         # Save missing data report
#         if self.members_missing_data:
#             missing_path = "data/members_missing_data.json"
#             with open(missing_path, 'w') as f:
#                 json.dump(self.members_missing_data, f, indent=2)
#             logger.info(f"✓ Saved missing data report to {missing_path}")
    
#     def update_google_sheets(self, assignments: Dict):
#         """Write tier assignments to Google Sheets"""
#         logger.info("Updating Google Sheets with tier assignments...")
        
#         try:
#             sheets = GoogleSheetsManager()
            
#             # Update member tier data
#             sheets.update_member_tier_data(assignments)
            
#             # Write tier history for changed tiers
#             changes = []
#             for member_id, data in assignments.items():
#                 if data.get('changed'):
#                     method = data.get('assignment_method', 'unknown')
                    
#                     if method == 'knn_prediction':
#                         reason = f"KNN prediction (conf: {data.get('knn_confidence', 0):.1%})"
#                     elif method == 'requirements_based':
#                         reason = f"Requirements ({data.get('requirements_met', 0)}/{data.get('requirements_needed', 0)})"
#                     else:
#                         reason = method.replace('_', ' ').title()
                    
#                     changes.append({
#                         'member_id': int(member_id),
#                         'date': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
#                         'old_tier': data['previous_tier'],
#                         'new_tier': data['tier'],
#                         'score': data.get('score', 0),
#                         'reason': reason
#                     })
            
#             if changes:
#                 sheets.write_tier_history(changes)
            
#             logger.info("✓ Google Sheets updated successfully")
            
#         except Exception as e:
#             logger.error(f"Error updating Google Sheets: {e}")
#             raise


# def main():
#     """Main execution"""
#     logger.info("Starting Tier Assignment System (Proportion-Based + KNN)")
    
#     try:
#         # Initialize tier assignment with 2/3 proportion threshold
#         tier_system = TierAssignment(proportion_threshold=2/3, knn_k=5)
        
#         # Generate assignments
#         assignments = tier_system.generate_tier_assignments()
        
#         # Save to JSON
#         tier_system.save_tier_assignments(assignments)
        
#         # Update Google Sheets
#         tier_system.update_google_sheets(assignments)
        
#         logger.info("\n✓ Tier assignment completed successfully!")
        
#     except Exception as e:
#         logger.error(f"Fatal error: {e}")
#         import traceback
#         traceback.print_exc()
#         sys.exit(1)


# if __name__ == "__main__":
#     main()