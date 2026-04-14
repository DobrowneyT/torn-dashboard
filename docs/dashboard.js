/**
 * TNL Forge Faction Dashboard
 * Fetches and displays faction data from GitHub
 */

// ============================================
// Configuration
// ============================================

const CONFIG = {
    // CHANGE THESE TO YOUR ACTUAL URLs
    cprDataUrl: 'https://gist.githubusercontent.com/DobrowneyT/b5fb2575247f45a44c692406bf4c4a9a/raw/cpr_database.json',
    crimesDataUrl: 'https://raw.githubusercontent.com/DobrownT/torn-forge-oc-2.0/main/data/crimes_database.json',

    // Tier requirements (from your tier assignment script)
    tierRequirements: {
        1: [
            { level: 8, role: "Imitator", minCpr: 70 },
            { level: 8, role: "Muscle", minCpr: 65 },
            { level: 8, role: "Thief", minCpr: 65 }
        ],
        2: [
            { level: 8, role: "Muscle", minCpr: 60 },
            { level: 8, role: "Robber", minCpr: 60 },
            { level: 8, role: "Assassin", minCpr: 67 },
            { level: 8, role: "Cat Burglar", minCpr: 67 },
            { level: 8, role: "Cleaner", minCpr: 67 },
            { level: 7, role: "Muscle", minCpr: 75 },
            { level: 7, role: "Engineer", minCpr: 75 },
            { level: 7, role: "Bomber", minCpr: 75 }
        ],
        3: [
            { level: 7, role: "Hacker", minCpr: 70 },
            { level: 7, role: "Picklock", minCpr: 70 },
            { level: 6, role: "Bomber", minCpr: 75 },
            { level: 6, role: "Driver", minCpr: 75 },
            { level: 6, role: "Robber", minCpr: 75 }
        ],
        4: [
            { level: 6, role: "Bomber", minCpr: 70 },
            { level: 6, role: "Robber", minCpr: 70 },
            { level: 6, role: "Enforcer", minCpr: 75 },
            { level: 6, role: "Muscle", minCpr: 75 }
        ],
        5: [
            { level: 5, role: "Average", minCpr: 75, isAverage: true }
        ],
        6: [
            { level: 4, role: "Average", minCpr: 75, isAverage: true }
        ]
    },

    // Payout ticket distribution
    payoutTickets: {
        1: 40,
        2: 30,
        3: 15,
        4: 7,
        5: 3,
        6: 0
    }
};

// ============================================
// Global State
// ============================================

let state = {
    cprData: null,
    crimesData: null,
    filteredMembers: [],
    filteredCrimes: []
};

// ============================================
// Initialize Dashboard
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Initializing Torn Forge Dashboard...');

    // Setup event listeners
    setupEventListeners();

    // Load data
    await loadAllData();

    // Render dashboard
    renderDashboard();
});

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            const tabName = e.target.dataset.tab;
            switchTab(tabName);
        });
    });

    // Member search
    const memberSearch = document.getElementById('memberSearch');
    if (memberSearch) {
        memberSearch.addEventListener('input', (e) => {
            filterMembers(e.target.value);
        });
    }

    // Tier filter
    const tierFilter = document.getElementById('tierFilter');
    if (tierFilter) {
        tierFilter.addEventListener('change', (e) => {
            filterMembersByTier(e.target.value);
        });
    }

    // Crime filters
    const crimeFilter = document.getElementById('crimeFilter');
    if (crimeFilter) {
        crimeFilter.addEventListener('change', () => {
            filterCrimes();
        });
    }

    const statusFilter = document.getElementById('statusFilter');
    if (statusFilter) {
        statusFilter.addEventListener('change', () => {
            filterCrimes();
        });
    }

    // Payout period
    const payoutPeriod = document.getElementById('payoutPeriod');
    if (payoutPeriod) {
        payoutPeriod.addEventListener('change', () => {
            renderPayouts();
        });
    }
}

function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // Update tab content
    document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');
}

// ============================================
// Data Loading
// ============================================

async function loadAllData() {
    try {
        // Load CPR data
        console.log('📊 Loading CPR data...');
        const cprResponse = await fetch(CONFIG.cprDataUrl);
        if (!cprResponse.ok) throw new Error('Failed to load CPR data');
        state.cprData = await cprResponse.json();
        console.log(`✓ Loaded CPR data for ${Object.keys(state.cprData.members || {}).length} members`);

        // Load crimes data
        console.log('📊 Loading crimes data...');
        try {
            const crimesResponse = await fetch(CONFIG.crimesDataUrl);
            if (crimesResponse.ok) {
                state.crimesData = await crimesResponse.json();
                console.log(`✓ Loaded ${Object.keys(state.crimesData || {}).length} crimes`);
            } else {
                console.warn('⚠ Crimes data not available yet');
                state.crimesData = { crimes: {} };
            }
        } catch (error) {
            console.warn('⚠ Crimes data not available yet:', error.message);
            state.crimesData = { crimes: {} };
        }

        // Initialize filtered data
        state.filteredMembers = Object.entries(state.cprData.members || {});
        state.filteredCrimes = Object.entries(state.crimesData.crimes || {});

    } catch (error) {
        console.error('❌ Error loading data:', error);
        showError('Failed to load data. Please check console for details.');
    }
}

// ============================================
// Render Dashboard
// ============================================

function renderDashboard() {
    updateLastUpdated();
    updateStatsOverview();
    renderMembersTable();
    renderCrimesTable();
    renderTierRequirements();
    renderPayouts();
}

function updateLastUpdated() {
    const lastUpdated = state.cprData?.metadata?.last_updated;
    const element = document.getElementById('lastUpdated');

    if (lastUpdated && element) {
        const date = new Date(lastUpdated);
        element.textContent = `Last updated: ${date.toLocaleString()}`;
    }
}

function updateStatsOverview() {
    const members = state.cprData?.members || {};
    const crimes = state.crimesData?.crimes || {};

    // Total members
    document.getElementById('totalMembers').textContent = Object.keys(members).length;

    // Total crimes
    const completedCrimes = Object.values(crimes).filter(c => c.status === 'completed').length;
    document.getElementById('totalCrimes').textContent = completedCrimes.toLocaleString();

    // Total payout
    const totalPayout = Object.values(crimes)
        .filter(c => c.status === 'completed')
        .reduce((sum, c) => sum + (c.payout || 0), 0);
    document.getElementById('totalPayout').textContent = `$${(totalPayout / 1e6).toFixed(1)}M`;

    // Average CPR
    let totalCpr = 0;
    let cprCount = 0;

    Object.values(members).forEach(member => {
        const cprByRole = member.cpr_by_role || {};
        Object.values(cprByRole).forEach(level => {
            Object.values(level).forEach(cpr => {
                if (typeof cpr === 'number') {
                    totalCpr += cpr;
                    cprCount++;
                }
            });
        });
    });

    const avgCpr = cprCount > 0 ? (totalCpr / cprCount).toFixed(1) : 0;
    document.getElementById('avgCPR').textContent = avgCpr;
}

// ============================================
// Members Table
// ============================================

function renderMembersTable() {
    const tbody = document.getElementById('membersTableBody');
    if (!tbody) return;

    if (state.filteredMembers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No members found</td></tr>';
        return;
    }

    const rows = state.filteredMembers
        .sort((a, b) => {
            const tierA = a[1].tier || 6;
            const tierB = b[1].tier || 6;
            return tierA - tierB;
        })
        .map(([memberId, memberData]) => {
            const tier = memberData.tier || 6;
            const name = memberData.name || `Member ${memberId}`;
            const totalCrimes = calculateMemberTotalCrimes(memberId);
            const avgCpr = calculateMemberAvgCpr(memberData);
            const lastUpdated = memberData.tier_last_updated || memberData.last_scraped || 'Never';
            const topRoles = getTopRoles(memberData);

            const lastUpdatedDate = lastUpdated !== 'Never'
                ? new Date(lastUpdated).toLocaleDateString()
                : 'Never';

            return `
                <tr>
                    <td><strong>${name}</strong></td>
                    <td><span class="tier-badge tier-${tier}">Tier ${tier}</span></td>
                    <td>${totalCrimes}</td>
                    <td>${avgCpr}</td>
                    <td>${lastUpdatedDate}</td>
                    <td>${topRoles}</td>
                </tr>
            `;
        })
        .join('');

    tbody.innerHTML = rows;
}

function calculateMemberTotalCrimes(memberId) {
    const crimes = state.crimesData?.crimes || {};
    return Object.values(crimes).filter(crime => {
        const participants = crime.participants || [];
        return participants.some(p => p.user_id === parseInt(memberId));
    }).length;
}

function calculateMemberAvgCpr(memberData) {
    const cprByRole = memberData.cpr_by_role || {};
    let total = 0;
    let count = 0;

    Object.values(cprByRole).forEach(level => {
        Object.values(level).forEach(cpr => {
            if (typeof cpr === 'number') {
                total += cpr;
                count++;
            }
        });
    });

    return count > 0 ? (total / count).toFixed(1) : 'N/A';
}

function getTopRoles(memberData) {
    const cprByRole = memberData.cpr_by_role || {};
    const allRoles = [];

    Object.entries(cprByRole).forEach(([level, roles]) => {
        Object.entries(roles).forEach(([role, cpr]) => {
            if (typeof cpr === 'number') {
                allRoles.push({ level, role, cpr });
            }
        });
    });

    const topThree = allRoles
        .sort((a, b) => b.cpr - a.cpr)
        .slice(0, 3)
        .map(r => `L${r.level} ${r.role}`)
        .join(', ');

    return topThree || 'No data';
}

function filterMembers(searchTerm) {
    const members = state.cprData?.members || {};
    const tierFilter = document.getElementById('tierFilter')?.value;

    state.filteredMembers = Object.entries(members).filter(([memberId, memberData]) => {
        const name = memberData.name || '';
        const matchesSearch = name.toLowerCase().includes(searchTerm.toLowerCase());
        const tier = memberData.tier || 6;
        const matchesTier = tierFilter === 'all' || tier === parseInt(tierFilter);

        return matchesSearch && matchesTier;
    });

    renderMembersTable();
}

function filterMembersByTier(tierValue) {
    const searchTerm = document.getElementById('memberSearch')?.value || '';
    filterMembers(searchTerm);
}

// ============================================
// Crimes Table
// ============================================

function renderCrimesTable() {
    const tbody = document.getElementById('crimesTableBody');
    if (!tbody) return;

    if (state.filteredCrimes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No crimes found</td></tr>';
        return;
    }

    const rows = state.filteredCrimes
        .sort((a, b) => {
            const dateA = new Date(a[1].completed_at || a[1].created_at || 0);
            const dateB = new Date(b[1].completed_at || b[1].created_at || 0);
            return dateB - dateA;
        })
        .slice(0, 100) // Show latest 100
        .map(([crimeId, crimeData]) => {
            const name = crimeData.name || 'Unknown';
            const difficulty = crimeData.difficulty || 'N/A';
            const status = crimeData.status || 'unknown';
            const payout = crimeData.payout || 0;
            const participants = crimeData.participants || [];
            const date = new Date(crimeData.completed_at || crimeData.created_at || 0);

            const statusClass = status === 'completed' ? 'completed' :
                               status === 'failed' ? 'failed' : 'in-progress';

            return `
                <tr>
                    <td>${crimeId}</td>
                    <td>${name}</td>
                    <td>Level ${difficulty}</td>
                    <td><span class="status-badge ${statusClass}">${status}</span></td>
                    <td>$${(payout / 1e6).toFixed(2)}M</td>
                    <td>${participants.length} members</td>
                    <td>${date.toLocaleDateString()}</td>
                </tr>
            `;
        })
        .join('');

    tbody.innerHTML = rows;
}

function filterCrimes() {
    const daysFilter = parseInt(document.getElementById('crimeFilter')?.value || 'all');
    const statusFilter = document.getElementById('statusFilter')?.value || 'all';
    const crimes = state.crimesData?.crimes || {};

    const cutoffDate = daysFilter !== 'all' && !isNaN(daysFilter)
        ? new Date(Date.now() - daysFilter * 24 * 60 * 60 * 1000)
        : null;

    state.filteredCrimes = Object.entries(crimes).filter(([crimeId, crimeData]) => {
        const crimeDate = new Date(crimeData.completed_at || crimeData.created_at || 0);
        const matchesDate = !cutoffDate || crimeDate >= cutoffDate;
        const matchesStatus = statusFilter === 'all' || crimeData.status === statusFilter;

        return matchesDate && matchesStatus;
    });

    renderCrimesTable();
}

// ============================================
// Tier Requirements
// ============================================

function renderTierRequirements() {
    const container = document.getElementById('tierRequirements');
    if (!container) return;

    const html = Object.entries(CONFIG.tierRequirements)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([tier, requirements]) => {
            const tierNum = parseInt(tier);
            const tickets = CONFIG.payoutTickets[tierNum];

            const requirementsList = requirements.map(req => {
                if (req.isAverage) {
                    return `
                        <div class="requirement-item">
                            <span>Level ${req.level} Average ≥ ${req.minCpr} CPR</span>
                        </div>
                    `;
                } else {
                    return `
                        <div class="requirement-item">
                            <span>Level ${req.level} ${req.role} ≥ ${req.minCpr} CPR</span>
                        </div>
                    `;
                }
            }).join('');

            return `
                <div class="tier-requirement-card">
                    <div class="tier-requirement-header">
                        <span class="tier-badge tier-${tier}">Tier ${tier}</span>
                        <h3>Requirements</h3>
                        <span class="text-muted" style="margin-left: auto;">${tickets} payout tickets</span>
                    </div>
                    <div class="requirements-list">
                        ${requirementsList}
                    </div>
                    <p class="text-muted mt-2">
                        Must meet ${Math.ceil(requirements.length * 2/3)} out of ${requirements.length} requirements
                    </p>
                </div>
            `;
        })
        .join('');

    container.innerHTML = html;
}

// ============================================
// Payouts
// ============================================

function renderPayouts() {
    const container = document.getElementById('payoutGrid');
    if (!container) return;

    const period = parseInt(document.getElementById('payoutPeriod')?.value || '30');
    const members = state.cprData?.members || {};
    const crimes = state.crimesData?.crimes || {};

    // Calculate cutoff date
    const cutoffDate = period === 'all'
        ? new Date(0)
        : new Date(Date.now() - period * 24 * 60 * 60 * 1000);

    // Calculate payouts by member
    const payouts = {};

    Object.entries(members).forEach(([memberId, memberData]) => {
        const tier = memberData.tier || 6;
        const tickets = CONFIG.payoutTickets[tier] || 0;
        const name = memberData.name || `Member ${memberId}`;

        // Count crimes in period
        const crimesInPeriod = Object.values(crimes).filter(crime => {
            const crimeDate = new Date(crime.completed_at || crime.created_at || 0);
            const isInPeriod = crimeDate >= cutoffDate;
            const participated = (crime.participants || []).some(p => p.user_id === parseInt(memberId));
            return isInPeriod && participated && crime.status === 'completed';
        });

        payouts[memberId] = {
            name,
            tier,
            tickets,
            crimesCount: crimesInPeriod.length,
            totalPayout: crimesInPeriod.reduce((sum, c) => sum + (c.payout || 0), 0)
        };
    });

    // Sort by total payout
    const sortedPayouts = Object.entries(payouts)
        .sort((a, b) => b[1].totalPayout - a[1].totalPayout)
        .slice(0, 20); // Top 20

    const html = sortedPayouts.map(([memberId, data]) => `
        <div class="payout-card">
            <h4>${data.name}</h4>
            <div class="payout-amount">$${(data.totalPayout / 1e6).toFixed(2)}M</div>
            <div class="payout-meta">
                <div><span class="tier-badge tier-${data.tier}">Tier ${data.tier}</span></div>
                <div class="mt-1">${data.crimesCount} crimes • ${data.tickets} tickets</div>
            </div>
        </div>
    `).join('');

    container.innerHTML = html || '<p class="text-center text-muted">No payout data available</p>';
}

// ============================================
// Error Handling
// ============================================

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-banner';
    errorDiv.textContent = message;
    errorDiv.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ef4444;
        color: white;
        padding: 1rem 1.5rem;
        border-radius: 0.5rem;
        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
        z-index: 1000;
    `;

    document.body.appendChild(errorDiv);

    setTimeout(() => {
        errorDiv.remove();
    }, 5000);
}

// ============================================
// Export for debugging
// ============================================

window.dashboard = {
    state,
    CONFIG,
    reloadData: loadAllData,
    renderDashboard
};

console.log('✓ Dashboard ready. Access state via: window.dashboard');
