"""
OC Scheduler Validation & Testing Script
Validates the scheduler logic and provides detailed analysis
"""

import json
from typing import Dict, List
from collections import defaultdict
from datetime import datetime, timedelta


class SchedulerValidator:
    """Validates scheduler assignments and provides analysis"""
    
    def __init__(self, assignments: List, available_crimes: List, available_members: List):
        self.assignments = assignments
        self.crimes = {c['id']: c for c in available_crimes}
        self.members = {m['id']: m for m in available_members}
    
    def validate_assignments(self) -> Dict:
        """Run all validation checks"""
        results = {
            'valid': True,
            'errors': [],
            'warnings': [],
            'stats': {}
        }
        
        # Check 1: No member assigned twice
        member_counts = defaultdict(int)
        for a in self.assignments:
            member_counts[a.member_id] += 1
        
        duplicates = {m: c for m, c in member_counts.items() if c > 1}
        if duplicates:
            results['valid'] = False
            results['errors'].append(f"Members assigned multiple times: {duplicates}")
        
        # Check 2: All assigned members are available
        assigned_member_ids = {a.member_id for a in self.assignments}
        available_member_ids = {m['id'] for m in self.members.values()}
        
        invalid_members = assigned_member_ids - available_member_ids
        if invalid_members:
            results['valid'] = False
            results['errors'].append(f"Members not available: {invalid_members}")
        
        # Check 3: CPR requirements met
        low_cpr_assignments = []
        for a in self.assignments:
            if a.member_cpr < a.required_cpr:
                low_cpr_assignments.append({
                    'member': a.member_name,
                    'crime': a.crime_name,
                    'has': a.member_cpr,
                    'needs': a.required_cpr
                })
        
        if low_cpr_assignments:
            results['valid'] = False
            results['errors'].append(f"CPR requirements not met: {low_cpr_assignments}")
        
        # Check 4: Success rate warnings
        low_success = [a for a in self.assignments if a.success_probability < 0.5]
        if low_success:
            results['warnings'].append(
                f"{len(low_success)} assignments have <50% success rate"
            )
        
        # Check 5: Wait time warnings
        long_wait = [a for a in self.assignments if a.time_until_work > 24]
        if long_wait:
            results['warnings'].append(
                f"{len(long_wait)} assignments wait >24h before starting work"
            )
        
        # Calculate statistics
        results['stats'] = self._calculate_stats()
        
        return results
    
    def _calculate_stats(self) -> Dict:
        """Calculate assignment statistics"""
        if not self.assignments:
            return {}
        
        total_ev = sum(a.expected_value for a in self.assignments)
        avg_success = sum(a.success_probability for a in self.assignments) / len(self.assignments)
        avg_wait = sum(a.time_until_work for a in self.assignments) / len(self.assignments)
        
        # CPR efficiency: how much "excess" CPR are we using?
        cpr_excess = [(a.member_cpr - a.required_cpr) for a in self.assignments]
        avg_excess = sum(cpr_excess) / len(cpr_excess) if cpr_excess else 0
        
        # Crime distribution
        crime_dist = defaultdict(int)
        for a in self.assignments:
            crime_dist[a.crime_name] += 1
        
        return {
            'total_assignments': len(self.assignments),
            'total_expected_value': total_ev,
            'avg_success_rate': avg_success,
            'avg_wait_time_hours': avg_wait,
            'avg_cpr_excess': avg_excess,
            'crime_distribution': dict(crime_dist),
            'member_utilization': len(set(a.member_id for a in self.assignments)) / len(self.members) * 100
        }
    
    def print_validation_report(self):
        """Print a formatted validation report"""
        results = self.validate_assignments()
        
        print("\n" + "=" * 70)
        print("SCHEDULER VALIDATION REPORT")
        print("=" * 70)
        
        # Status
        status = "✅ VALID" if results['valid'] else "❌ INVALID"
        print(f"\nStatus: {status}")
        
        # Errors
        if results['errors']:
            print("\n🚫 ERRORS:")
            for error in results['errors']:
                print(f"  • {error}")
        
        # Warnings
        if results['warnings']:
            print("\n⚠️  WARNINGS:")
            for warning in results['warnings']:
                print(f"  • {warning}")
        
        # Statistics
        if results['stats']:
            stats = results['stats']
            print("\n📊 STATISTICS:")
            print(f"  Total Assignments: {stats['total_assignments']}")
            print(f"  Total Expected Value: ${stats['total_expected_value']:,.0f}")
            print(f"  Average Success Rate: {stats['avg_success_rate']:.1%}")
            print(f"  Average Wait Time: {stats['avg_wait_time_hours']:.1f} hours")
            print(f"  Average CPR Excess: {stats['avg_cpr_excess']:.1f}")
            print(f"  Member Utilization: {stats['member_utilization']:.1f}%")
            
            print("\n  Crime Distribution:")
            for crime, count in sorted(stats['crime_distribution'].items()):
                print(f"    • {crime}: {count} slots")
        
        print("\n" + "=" * 70)
        
        return results
    
    def compare_strategies(self, assignments_list: List[List], strategy_names: List[str]):
        """Compare multiple assignment strategies"""
        print("\n" + "=" * 70)
        print("STRATEGY COMPARISON")
        print("=" * 70)
        
        comparison = []
        
        for assignments, name in zip(assignments_list, strategy_names):
            self.assignments = assignments
            results = self.validate_assignments()
            stats = results['stats']
            
            comparison.append({
                'strategy': name,
                'assignments': stats.get('total_assignments', 0),
                'ev': stats.get('total_expected_value', 0),
                'success_rate': stats.get('avg_success_rate', 0),
                'wait_time': stats.get('avg_wait_time_hours', 0),
                'cpr_efficiency': stats.get('avg_cpr_excess', 0)
            })
        
        # Print comparison table
        print(f"\n{'Strategy':<20} {'Assigns':<10} {'Total EV':<15} {'Avg Success':<12} {'Avg Wait':<10} {'CPR Excess':<12}")
        print("-" * 80)
        
        for c in comparison:
            print(f"{c['strategy']:<20} {c['assignments']:<10} ${c['ev']:>13,.0f} {c['success_rate']:>10.1%} {c['wait_time']:>9.1f}h {c['cpr_efficiency']:>11.1f}")
        
        # Highlight best strategy
        best_ev = max(comparison, key=lambda x: x['ev'])
        print(f"\n🏆 Best Expected Value: {best_ev['strategy']}")
        
        print("=" * 70)


def test_scheduler_mock():
    """Test scheduler with mock data"""
    from oc_optimal_scheduler import OCScheduler, Assignment
    
    # Mock available crimes
    mock_crimes = [
        {
            'id': '924160',
            'name': 'Clinical Precision',
            'difficulty': 8,
            'status': 'Recruiting',
            'slots': [
                {'position_id': 'P1', 'position': 'Imitator', 'position_number': 1, 
                 'checkpoint_pass_rate': 70, 'user': None},
                {'position_id': 'P2', 'position': 'Cat Burglar', 'position_number': 2, 
                 'checkpoint_pass_rate': 78, 'user': None},
            ]
        },
        {
            'id': '924159',
            'name': 'Break the Bank',
            'difficulty': 8,
            'status': 'Recruiting',
            'slots': [
                {'position_id': 'P1', 'position': 'Robber', 'position_number': 1, 
                 'checkpoint_pass_rate': 60, 'user': None},
                {'position_id': 'P2', 'position': 'Muscle', 'position_number': 2, 
                 'checkpoint_pass_rate': 65, 'user': None},
            ]
        }
    ]
    
    # Mock available members
    mock_members = [
        {'id': 1, 'name': 'Alice', 'is_in_oc': False},
        {'id': 2, 'name': 'Bob', 'is_in_oc': False},
        {'id': 3, 'name': 'Charlie', 'is_in_oc': False},
    ]
    
    # Mock assignments (you would get these from scheduler.find_optimal_assignments)
    mock_assignments = [
        Assignment(
            crime_id='924160',
            crime_name='Clinical Precision',
            slot_position='P1',
            role_name='Imitator',
            member_id=1,
            member_name='Alice',
            member_cpr=75,
            required_cpr=70,
            success_probability=0.68,
            expected_value=95_000_000,
            time_until_work=0
        ),
        Assignment(
            crime_id='924159',
            crime_name='Break the Bank',
            slot_position='P1',
            role_name='Robber',
            member_id=2,
            member_name='Bob',
            member_cpr=62,
            required_cpr=60,
            success_probability=0.71,
            expected_value=125_000_000,
            time_until_work=8
        ),
    ]
    
    # Validate
    validator = SchedulerValidator(mock_assignments, mock_crimes, mock_members)
    validator.print_validation_report()


if __name__ == "__main__":
    print("Running scheduler validation tests...")
    test_scheduler_mock()