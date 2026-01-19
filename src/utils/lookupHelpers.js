import { supabase } from './supabase';

const itemCache = new Map();
const memberCache = new Map();

export async function getItemName(itemId) {
    if (itemCache.has(itemId)) {
        return itemCache.get(itemId);
    }
    
    const { data, error } = await supabase
        .from('items')
        .select('name')
        .eq('id', itemId)
        .single();
    
    const name = error || !data ? `Item ${itemId}` : data.name;
    itemCache.set(itemId, name);
    return name;
}

export async function getMemberName(memberId) {
    if (memberCache.has(memberId)) {
        return memberCache.get(memberId);
    }
    
    const { data, error } = await supabase
        .from('members')
        .select('member_name')
        .eq('member_id', memberId)
        .single();
    
    const name = error || !data ? `Member ${memberId}` : data.member_name;
    memberCache.set(memberId, name);
    return name;
}

export async function enrichItemBreakdown(itemBreakdown) {
    if (!itemBreakdown) return null;
    
    const enriched = { rewards: {}, costs: {} };
    
    if (itemBreakdown.rewards) {
        for (const [itemId, data] of Object.entries(itemBreakdown.rewards)) {
            const name = await getItemName(parseInt(itemId));
            enriched.rewards[itemId] = { ...data, name };
        }
    }
    
    if (itemBreakdown.costs) {
        for (const [itemId, data] of Object.entries(itemBreakdown.costs)) {
            const name = await getItemName(parseInt(itemId));
            enriched.costs[itemId] = { ...data, name };
        }
    }
    
    return enriched;
}

export function clearCaches() {
    itemCache.clear();
    memberCache.clear();
}