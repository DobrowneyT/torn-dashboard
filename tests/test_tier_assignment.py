"""
Test tier assignment locally
"""
import os
import sys
from scripts.assign_tiers import TierAssignment

def main():
    print("Testing Tier Assignment System")
    print("="*60)
    
    # Initialize
    tier_system = TierAssignment()
    
    # Generate assignments
    assignments = tier_system.generate_tier_assignments()
    
    print("\nSample assignments:")
    for member_id, data in list(assignments.items())[:5]:
        print(f"  Member {member_id}: Tier {data['tier']} (score: {data['score']})")
    
    # Save locally
    tier_system.save_tier_assignments(assignments)
    
    print("\n✓ Test completed! Check data/member_tiers.json")

if __name__ == "__main__":
    main()