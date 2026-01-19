export async function updateMemberStatus(supabase, currentMembers) {
    // Mark all as not current first
    await supabase
        .from('members')
        .update({ is_current: false, last_seen: new Date().toISOString() })
        .eq('is_current', true);
    
    // Upsert current members
    const memberData = currentMembers.map(m => ({
        member_id: m.member_id,
        member_name: m.member_name,
        is_current: true,
        last_seen: new Date().toISOString()
    }));
    
    const { error } = await supabase
        .from('members')
        .upsert(memberData, { onConflict: 'member_id' });
    
    if (error) {
        console.error('Error updating member status:', error);
    }
}