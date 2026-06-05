"""
Tier Assignment Script
Reads CPR v2 database (crime-name + position-label keyed).
Tier requirements match src/config.js tierRequirements exactly.
Uses proportion-based evaluation (2/3 rule) with top-down tier checking and KNN fallback.
"""

import json
import logging
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple, Optional
import math
from collections import Counter

sys.path.insert(0, str(Path(__file__).parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class TierAssignment:
    """Handles automatic tier assignment based on CPR v2 data"""

    # Mirrors src/config.js tierRequirements exactly.
    # type "role": member[crime][role]['cpr_value'] >= min_cpr
    # type "avg":  average of all CPR values across crimes with given difficulty >= min_cpr
    TIER_REQUIREMENTS = {
        1: [
            {"type": "role", "crime": "Clinical Precision", "role": "Imitator",    "min_cpr": 70},
            {"type": "role", "crime": "Break the Bank",     "role": "Muscle #3",   "min_cpr": 65},
            {"type": "role", "crime": "Break the Bank",     "role": "Thief #2",    "min_cpr": 65},
        ],
        2: [
            {"type": "role", "crime": "Break the Bank",     "role": "Muscle #1",   "min_cpr": 60},
            {"type": "role", "crime": "Break the Bank",     "role": "Robber",      "min_cpr": 60},
            {"type": "role", "crime": "Clinical Precision", "role": "Assassin",    "min_cpr": 67},
            {"type": "role", "crime": "Clinical Precision", "role": "Cat Burglar", "min_cpr": 67},
            {"type": "role", "crime": "Clinical Precision", "role": "Cleaner",     "min_cpr": 67},
            {"type": "role", "crime": "Blast from the Past","role": "Muscle",      "min_cpr": 75},
            {"type": "role", "crime": "Blast from the Past","role": "Engineer",    "min_cpr": 75},
            {"type": "role", "crime": "Blast from the Past","role": "Bomber",      "min_cpr": 75},
        ],
        3: [
            {"type": "role", "crime": "Blast from the Past","role": "Hacker",      "min_cpr": 70},
            {"type": "role", "crime": "Blast from the Past","role": "Picklock #1", "min_cpr": 70},
            {"type": "role", "crime": "Bidding War",        "role": "Bomber #2",   "min_cpr": 75},
            {"type": "role", "crime": "Bidding War",        "role": "Driver",      "min_cpr": 75},
            {"type": "role", "crime": "Bidding War",        "role": "Robber #2",   "min_cpr": 75},
        ],
        4: [
            {"type": "role", "crime": "Bidding War",        "role": "Bomber #1",   "min_cpr": 70},
            {"type": "role", "crime": "Bidding War",        "role": "Robber #1",   "min_cpr": 70},
            {"type": "role", "crime": "Honey Trap",         "role": "Enforcer",    "min_cpr": 75},
            {"type": "role", "crime": "Honey Trap",         "role": "Muscle #1",   "min_cpr": 75},
        ],
        5: [
            {"type": "avg", "difficulty": 5, "min_cpr": 75},
        ],
        6: [
            {"type": "avg", "difficulty": 4, "min_cpr": 75},
        ],
    }

    def __init__(self, proportion_threshold: float = 2/3, knn_k: int = 5,
                 member_cpr: Optional[Dict] = None, crime_types: Optional[Dict] = None):
        self.proportion_threshold = proportion_threshold
        self.knn_k = knn_k
        # DB-native callers inject the in-memory v2 data directly; standalone
        # runs fall back to reading the (legacy) JSON file.
        if member_cpr is not None and crime_types is not None:
            self.cpr_data, self.crime_types = member_cpr, crime_types
            logger.info(f"✓ Using injected CPR v2 data: {len(member_cpr)} members, {len(crime_types)} crime types")
        else:
            self.cpr_data, self.crime_types = self.load_cpr_data()
        self.knn_list: List[Dict] = []
        self.members_no_data: List[Dict] = []
        self.pass1_assignments: Dict = {}

        # difficulty → [crime_name] index for average-based requirements
        self.crimes_by_difficulty: Dict[int, List[str]] = {}
        for crime, info in self.crime_types.items():
            d = info.get('difficulty')
            if d is not None:
                self.crimes_by_difficulty.setdefault(d, []).append(crime)

        self.tier_requirements_needed = {
            tier: math.ceil(len(reqs) * self.proportion_threshold)
            for tier, reqs in self.TIER_REQUIREMENTS.items()
        }

        logger.info("Tier requirements (need to meet):")
        for tier in sorted(self.TIER_REQUIREMENTS.keys()):
            total = len(self.TIER_REQUIREMENTS[tier])
            needed = self.tier_requirements_needed[tier]
            logger.info(f"  Tier {tier}: {needed}/{total} requirements")

    def load_cpr_data(self) -> Tuple[Dict, Dict]:
        """Load CPR v2 database. Returns (member_cpr, crime_types)."""
        path = "data/cpr_database_v2.json"
        logger.info(f"Loading CPR v2 data from {path}")
        try:
            with open(path, 'r') as f:
                data = json.load(f)
            member_cpr = data.get('member_cpr', {})
            crime_types = data.get('crime_types', {})
            logger.info(f"✓ Loaded CPR v2 data for {len(member_cpr)} members, {len(crime_types)} crime types")
            return member_cpr, crime_types
        except FileNotFoundError:
            logger.warning(f"CPR v2 database not found: {path}")
            return {}, {}
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in CPR v2 database: {e}")
            return {}, {}

    def get_cpr_value(self, member_data: Dict, crime: str, role: str) -> Optional[float]:
        """Return CPR value for crime+role, or None if missing."""
        entry = member_data.get(crime, {}).get(role)
        if isinstance(entry, dict):
            return entry.get('cpr_value')
        return None

    def calculate_difficulty_average(self, member_data: Dict, difficulty: int) -> Optional[float]:
        """Average CPR across all positions in all crimes of the given difficulty."""
        crime_names = self.crimes_by_difficulty.get(difficulty, [])
        values = []
        for crime in crime_names:
            for role_data in member_data.get(crime, {}).values():
                if isinstance(role_data, dict):
                    v = role_data.get('cpr_value')
                    if isinstance(v, (int, float)):
                        values.append(v)
        if not values:
            return None
        return sum(values) / len(values)

    def evaluate_requirement(self, member_data: Dict, req: Dict) -> Tuple[bool, bool]:
        """Evaluate a single requirement dict. Returns (met, data_available)."""
        if req['type'] == 'avg':
            avg = self.calculate_difficulty_average(member_data, req['difficulty'])
            if avg is None:
                return False, False
            return avg >= req['min_cpr'], True
        else:
            cpr = self.get_cpr_value(member_data, req['crime'], req['role'])
            if cpr is None:
                return False, False
            return cpr >= req['min_cpr'], True

    def check_tier_requirements(self, member_id: str, member_data: Dict, tier: int) -> Dict:
        """Check all requirements for a tier. Returns status dict."""
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
                    label = (f"Avg Difficulty {req['difficulty']}" if req['type'] == 'avg'
                             else f"{req['crime']} {req['role']}")
                    failed_requirements.append(label)
            else:
                label = (f"Avg Difficulty {req['difficulty']}" if req['type'] == 'avg'
                         else f"{req['crime']} {req['role']}")
                missing_data.append(label)

        return {
            'meets_threshold': requirements_met >= requirements_needed,
            'requirements_met': requirements_met,
            'requirements_needed': requirements_needed,
            'data_points_available': data_points_available,
            'missing_data': missing_data,
            'failed_requirements': failed_requirements,
        }

    def get_all_cpr_datapoints(self, member_data: Dict) -> List[Tuple[str, str, float]]:
        """Return list of (crime, role, cpr_value) for all available data."""
        datapoints = []
        for crime, roles in member_data.items():
            if not isinstance(roles, dict):
                continue
            for role, role_data in roles.items():
                if not isinstance(role_data, dict):
                    continue
                v = role_data.get('cpr_value')
                if isinstance(v, (int, float)):
                    datapoints.append((crime, role, v))
        return datapoints

    def assign_tier_pass1(self, member_id: str, member_data: Dict) -> Optional[Dict]:
        """
        First pass: assign tier based on available data.
        - 0 data for tier → check next tier
        - Partial data → add to KNN list and stop
        - Full data + meets threshold → assign tier
        - Full data + misses threshold → check next tier
        Returns assignment dict, or None if queued for KNN.
        """
        all_datapoints = self.get_all_cpr_datapoints(member_data)

        if not all_datapoints:
            self.members_no_data.append({'member_id': member_id, 'reason': 'No CPR data'})
            logger.warning(f"Member {member_id}: No CPR data → Tier 0 for MANUAL REVIEW")
            return {
                'tier': 0,
                'previous_tier': 0,
                'changed': False,
                'total_crimes': 0,
                'requirements_met': 0,
                'requirements_needed': 0,
                'manual_override': False,
                'assignment_method': '⚠️ NO_DATA_MANUAL_REVIEW_REQUIRED',
                'last_updated': datetime.now().isoformat(),
            }

        for tier in range(1, 7):
            status = self.check_tier_requirements(member_id, member_data, tier)
            total_requirements = len(self.TIER_REQUIREMENTS[tier])

            if status['data_points_available'] == 0:
                logger.debug(f"Member {member_id} Tier {tier}: 0 data points, checking next tier")
                continue

            if status['data_points_available'] < total_requirements:
                self.knn_list.append({
                    'member_id': member_id,
                    'member_data': member_data,
                    'datapoints': all_datapoints,
                })
                logger.info(
                    f"Member {member_id}: Partial data at Tier {tier} "
                    f"({status['data_points_available']}/{total_requirements}), added to KNN list"
                )
                return None

            if status['meets_threshold']:
                logger.info(
                    f"Member {member_id}: → Tier {tier} "
                    f"({status['requirements_met']}/{len(self.TIER_REQUIREMENTS[tier])} reqs met)"
                )
                return {
                    'tier': tier,
                    'previous_tier': 0,
                    'changed': True,
                    'total_crimes': 0,
                    'requirements_met': status['requirements_met'],
                    'requirements_needed': status['requirements_needed'],
                    'manual_override': False,
                    'assignment_method': 'pass1_requirements',
                    'last_updated': datetime.now().isoformat(),
                }
            else:
                logger.debug(
                    f"Member {member_id} Tier {tier}: full data, doesn't meet threshold "
                    f"({status['requirements_met']}/{status['requirements_needed']}), checking next tier"
                )
                continue

        logger.warning(f"Member {member_id}: Has data but qualifies for no tier → Default Tier 6")
        return {
            'tier': 6,
            'previous_tier': 0,
            'changed': True,
            'total_crimes': 0,
            'requirements_met': 0,
            'requirements_needed': 0,
            'manual_override': False,
            'assignment_method': 'pass1_default_tier6',
            'last_updated': datetime.now().isoformat(),
        }

    def find_knn_for_datapoint(self, crime: str, role: str, cpr_value: float) -> List[int]:
        """Find K nearest neighbors by crime+role CPR from Pass 1 assignments."""
        neighbors = []
        for other_id, other_assignment in self.pass1_assignments.items():
            other_cpr = self.get_cpr_value(self.cpr_data[other_id], crime, role)
            if other_cpr is not None:
                neighbors.append((abs(cpr_value - other_cpr), other_assignment['tier']))

        if len(neighbors) < self.knn_k:
            return []

        nearest = sorted(neighbors, key=lambda x: x[0])[:self.knn_k]
        return [n[1] for n in nearest]

    def assign_tier_knn(self, member_id: str, member_data: Dict, datapoints: List[Tuple[str, str, float]]) -> Dict:
        """Second pass: KNN prediction for members with partial data."""
        role_predictions = []

        for crime, role, cpr_value in datapoints:
            neighbor_tiers = self.find_knn_for_datapoint(crime, role, cpr_value)
            if not neighbor_tiers:
                continue
            vote_counts = Counter(neighbor_tiers)
            role_predictions.append(vote_counts.most_common(1)[0][0])

        if not role_predictions:
            logger.warning(f"Member {member_id}: KNN failed (not enough neighbors) → Tier 6")
            return {
                'tier': 6, 'previous_tier': 0, 'changed': True,
                'total_crimes': 0, 'requirements_met': 0, 'requirements_needed': 0,
                'manual_override': False, 'assignment_method': 'knn_failed_default_tier6',
                'last_updated': datetime.now().isoformat(),
            }

        final_vote_counts = Counter(role_predictions)
        max_votes = max(final_vote_counts.values())
        final_tier = min(t for t, v in final_vote_counts.items() if v == max_votes)

        logger.info(f"Member {member_id}: KNN → Tier {final_tier} (votes: {dict(final_vote_counts)})")
        return {
            'tier': final_tier, 'previous_tier': 0, 'changed': True,
            'total_crimes': 0, 'requirements_met': 0, 'requirements_needed': 0,
            'manual_override': False, 'assignment_method': 'knn_prediction',
            'knn_num_datapoints': len(role_predictions),
            'knn_vote_counts': dict(final_vote_counts),
            'last_updated': datetime.now().isoformat(),
        }

    def generate_tier_assignments(self) -> Dict:
        """
        Two-pass tier assignment. Returns {member_id: assignment_dict}.
        Pass 1: direct requirement check on full data.
        Pass 2: KNN for members with partial data at any tier.
        """
        logger.info("="*60)
        logger.info("Generating Tier Assignments (v2 CPR, Two-Pass with KNN)")
        logger.info(f"Proportion threshold: {self.proportion_threshold:.2%}")
        logger.info("="*60)

        all_assignments = {}
        self.knn_list = []
        self.members_no_data = []
        self.pass1_assignments = {}

        logger.info("\n--- PASS 1: Assigning with available data ---")
        for member_id, member_data in self.cpr_data.items():
            assignment = self.assign_tier_pass1(member_id, member_data)
            if assignment:
                all_assignments[member_id] = assignment
                self.pass1_assignments[member_id] = assignment

        logger.info(
            f"\nPass 1 complete: {len(self.pass1_assignments)} assigned, "
            f"{len(self.knn_list)} KNN, {len(self.members_no_data)} no-data"
        )

        if self.knn_list:
            logger.info(f"\n--- PASS 2: KNN for {len(self.knn_list)} members ---")
            for knn_member in self.knn_list:
                assignment = self.assign_tier_knn(
                    knn_member['member_id'],
                    knn_member['member_data'],
                    knn_member['datapoints'],
                )
                all_assignments[knn_member['member_id']] = assignment

        self.print_summary(all_assignments)
        return all_assignments

    def print_summary(self, assignments: Dict):
        """Print tier distribution summary."""
        tier_counts: Dict[int, int] = {}
        for assignment in assignments.values():
            tier = assignment['tier']
            tier_counts[tier] = tier_counts.get(tier, 0) + 1

        logger.info("\n" + "="*60)
        logger.info("Tier Assignment Summary")
        logger.info("="*60)
        logger.info(f"Total members in v2 DB: {len(self.cpr_data)}")
        logger.info(f"Assigned: {len(assignments)}, No data: {len(self.members_no_data)}")
        logger.info("\nTier distribution:")
        if tier_counts.get(0):
            logger.info(f"  ⚠️  Tier 0 (MANUAL REVIEW): {tier_counts[0]}")
        for tier in range(1, 7):
            if tier_counts.get(tier):
                logger.info(f"  Tier {tier}: {tier_counts[tier]} members")
        logger.info("="*60)


def main():
    """Main execution"""
    logger.info("Starting Tier Assignment System (v2 CPR, Proportion-Based + KNN)")
    try:
        tier_system = TierAssignment(proportion_threshold=2/3, knn_k=5)
        assignments = tier_system.generate_tier_assignments()
        logger.info("\n✓ Tier assignment completed. Tiers applied by cpr_scraper upgrade-only logic.")
        return assignments
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()