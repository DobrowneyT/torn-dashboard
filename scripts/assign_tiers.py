"""
Tier Assignment Script
Automatically assigns member tiers based on CPR performance data
"""

import json
import logging
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple, Optional

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
    
    def __init__(self, config_path: str = "data/tier_config.json"):
        self.config = self.load_config(config_path)
        self.cpr_data = self.load_cpr_data()
        self.existing_tiers = self.load_existing_tiers()
    
    def load_config(self, path: str) -> Dict:
        """Load tier configuration"""
        logger.info(f"Loading tier configuration from {path}")
        try:
            with open(path, 'r') as f:
                config = json.load(f)
            logger.info("✓ Configuration loaded successfully")
            return config
        except FileNotFoundError:
            logger.error(f"Configuration file not found: {path}")
            raise
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in configuration: {e}")
            raise
    
    def load_cpr_data(self) -> Dict:
        """Load CPR database"""
        path = "data/cpr_database.json"
        logger.info(f"Loading CPR data from {path}")
        try:
            with open(path, 'r') as f:
                data = json.load(f)
            logger.info(f"✓ Loaded CPR data for {len(data)} members")

            # Extract data from 'members'
            if 'members' in data:
                return data['members']  
            
            return data  # ✅ Or return as-is if flat structure
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
    
    def calculate_member_score(self, member_id: str, member_data: Dict) -> Tuple[float, int, List[str]]:
        """
        Calculate weighted average CPR score for a member
        
        Returns:
            (score, total_crimes, evaluated_roles)
        """
        criteria = self.config['evaluation_criteria']
        roles_config = criteria['roles_to_evaluate']
        
        cpr_by_difficulty = member_data.get('cpr_by_difficulty', {})
        total_crimes = member_data.get('total_crimes', 0)
        
        # Check minimum crimes requirement
        if total_crimes < criteria['minimum_crimes_for_evaluation']:
            logger.debug(f"Member {member_id} has only {total_crimes} crimes (min: {criteria['minimum_crimes_for_evaluation']})")
            return -1.0, total_crimes, []  # Signal: not enough data
        
        weighted_sum = 0.0
        total_weight = 0.0
        evaluated_roles = []
        
        # Calculate weighted average across all specified role/difficulty combinations
        for role_config in roles_config:
            difficulty = role_config['difficulty']
            roles = role_config['roles']
            weight = role_config['weight']
            
            if difficulty not in cpr_by_difficulty:
                continue
            
            difficulty_data = cpr_by_difficulty[difficulty]
            
            for role in roles:
                if role in difficulty_data:
                    cpr = difficulty_data[role]
                    weighted_sum += cpr * weight
                    total_weight += weight
                    evaluated_roles.append(f"{difficulty}/{role}")
        
        # Calculate final score
        if total_weight == 0:
            logger.warning(f"Member {member_id} has no CPR data for evaluated roles")
            return -1.0, total_crimes, []
        
        score = weighted_sum / total_weight
        
        logger.debug(f"Member {member_id}: score={score:.2f}, crimes={total_crimes}, roles={len(evaluated_roles)}")
        return score, total_crimes, evaluated_roles
    
    def assign_tier(self, score: float) -> int:
        """
        Assign tier based on score and thresholds
        
        Returns:
            Tier number (1-5)
        """
        thresholds = self.config['tier_thresholds']['thresholds']
        
        # Sort thresholds by min_cpr descending (highest first)
        sorted_thresholds = sorted(thresholds, key=lambda x: x['min_cpr'], reverse=True)
        
        for threshold in sorted_thresholds:
            if score >= threshold['min_cpr']:
                return threshold['tier']
        
        # Fallback to lowest tier
        return 5
    
    def check_manual_override(self, member_id: str) -> Optional[Dict]:
        """Check if member has a manual tier override"""
        if member_id not in self.existing_tiers:
            return None
        
        tier_data = self.existing_tiers[member_id]
        if tier_data.get('manual_override', False):
            return tier_data
        
        return None
    
    def apply_grace_period(self, member_id: str, new_tier: int, old_tier: int) -> int:
        """
        Apply grace period for tier downgrades
        
        Returns:
            Actual tier to assign (may be old tier if in grace period)
        """
        if new_tier >= old_tier:
            # Promotion or same tier - no grace period
            return new_tier
        
        grace_days = self.config['assignment_rules']['grace_period_days']
        
        if member_id in self.existing_tiers:
            last_change = self.existing_tiers[member_id].get('last_tier_change')
            if last_change:
                last_change_date = datetime.fromisoformat(last_change)
                days_since_change = (datetime.now() - last_change_date).days
                
                if days_since_change < grace_days:
                    logger.info(f"Grace period: Member {member_id} in grace period ({days_since_change}/{grace_days} days)")
                    return old_tier  # Maintain old tier during grace period
        
        return new_tier
    
    def generate_tier_assignments(self) -> Dict:
        """
        Generate tier assignments for all members
        
        Returns:
            Dictionary of member assignments with metadata
        """
        logger.info("="*60)
        logger.info("Generating Tier Assignments")
        logger.info("="*60)
        
        assignments = {}
        default_tier = self.config['evaluation_criteria']['default_tier_for_new_members']
        
        for member_id, member_data in self.cpr_data.items():
            logger.debug(f"\nProcessing member {member_id}...")
            
            # Check for manual override
            override = self.check_manual_override(member_id)
            if override:
                logger.info(f"Member {member_id} has manual override: Tier {override['tier']}")
                assignments[member_id] = {
                    'tier': override['tier'],
                    'score': override.get('score', 0.0),
                    'previous_tier': override.get('tier'),
                    'changed': False,
                    'manual_override': True,
                    'override_reason': override.get('override_reason', 'Manual assignment'),
                    'total_crimes': member_data.get('total_crimes', 0),
                    'evaluated_roles': []
                }
                continue
            
            # Calculate score
            score, total_crimes, evaluated_roles = self.calculate_member_score(member_id, member_data)
            
            # Handle insufficient data
            if score < 0:
                logger.info(f"Member {member_id} assigned default tier {default_tier} (insufficient data)")
                assignments[member_id] = {
                    'tier': default_tier,
                    'score': 0.0,
                    'previous_tier': self.existing_tiers.get(member_id, {}).get('tier', default_tier),
                    'changed': False,
                    'insufficient_data': True,
                    'total_crimes': total_crimes,
                    'evaluated_roles': []
                }
                continue
            
            # Assign tier based on score
            calculated_tier = self.assign_tier(score)
            previous_tier = self.existing_tiers.get(member_id, {}).get('tier', calculated_tier)
            
            # Apply grace period for downgrades
            final_tier = self.apply_grace_period(member_id, calculated_tier, previous_tier)
            
            # Check if tier changed
            changed = final_tier != previous_tier
            
            if changed:
                direction = "↑ Promoted" if final_tier < previous_tier else "↓ Demoted"
                logger.info(f"Member {member_id}: {direction} from Tier {previous_tier} to Tier {final_tier} (score: {score:.2f})")
            
            assignments[member_id] = {
                'tier': final_tier,
                'score': round(score, 2),
                'previous_tier': previous_tier,
                'changed': changed,
                'total_crimes': total_crimes,
                'evaluated_roles': evaluated_roles,
                'manual_override': False,
                'last_updated': datetime.now().isoformat()
            }
        
        # Summary statistics
        tier_counts = {}
        changes = {'promoted': 0, 'demoted': 0, 'unchanged': 0}
        
        for assignment in assignments.values():
            tier = assignment['tier']
            tier_counts[tier] = tier_counts.get(tier, 0) + 1
            
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
        logger.info(f"Total members evaluated: {len(assignments)}")
        logger.info(f"Tier distribution:")
        for tier in sorted(tier_counts.keys()):
            tier_name = self.config['tier_definitions'][str(tier)]['name']
            logger.info(f"  Tier {tier} ({tier_name}): {tier_counts[tier]} members")
        logger.info(f"\nChanges:")
        logger.info(f"  Promoted: {changes['promoted']}")
        logger.info(f"  Demoted: {changes['demoted']}")
        logger.info(f"  Unchanged: {changes['unchanged']}")
        logger.info("="*60)
        
        return assignments
    
    def save_tier_assignments(self, assignments: Dict):
        """Save tier assignments to member_tiers.json"""
        output_path = "data/member_tiers.json"
        logger.info(f"Saving tier assignments to {output_path}")
        
        # Convert to simpler format for storage
        simplified = {}
        for member_id, data in assignments.items():
            simplified[member_id] = {
                'tier': data['tier'],
                'score': data['score'],
                'previous_tier': data['previous_tier'],
                'last_updated': data.get('last_updated', datetime.now().isoformat()),
                'manual_override': data.get('manual_override', False),
                'total_crimes': data['total_crimes']
            }
            
            if data.get('manual_override'):
                simplified[member_id]['override_reason'] = data.get('override_reason', '')
        
        with open(output_path, 'w') as f:
            json.dump(simplified, f, indent=2)
        
        logger.info(f"✓ Saved {len(simplified)} tier assignments")
    
    def update_google_sheets(self, assignments: Dict):
        """Write tier assignments to Google Sheets"""
        logger.info("Updating Google Sheets with tier assignments...")
        
        try:
            sheets = GoogleSheetsManager()
            
            # Use new method that matches by Member ID and updates only tier columns
            sheets.update_member_tier_data(assignments)
            
            # Optional: Write tier history for changed tiers
            changes = []
            for member_id, data in assignments.items():
                if data.get('changed'):
                    changes.append({
                        'member_id': int(member_id),
                        'date': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                        'old_tier': data['previous_tier'],
                        'new_tier': data['tier'],
                        'score': data.get('score', 0),
                        'reason': 'CPR-based assignment'
                    })
            
            if changes:
                sheets.write_tier_history(changes)
            
            logger.info("✓ Google Sheets updated successfully")
            
        except Exception as e:
            logger.error(f"Error updating Google Sheets: {e}")
            raise

def main():
    """Main execution"""
    logger.info("Starting Tier Assignment System")
    
    try:
        # Initialize tier assignment
        tier_system = TierAssignment()
        
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