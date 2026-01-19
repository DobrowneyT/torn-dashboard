import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

const supabase = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey
);

async function syncItems() {
    console.log('Fetching all items from Torn API...');
    
    const response = await fetch(
        `https://api.torn.com/v2/torn/items?cat=All&sort=ASC&key=${config.torn.apiKey}`
    );
    
    if (!response.ok) {
        throw new Error(`API request failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data.items || data.items.length === 0) {
        console.log('No items returned from API');
        return;
    }
    
    console.log(`Received ${data.items.length} items from API`);
    
    const itemsToUpsert = data.items.map(item => ({
        id: item.id,
        name: item.name,
        description: item.description,
        effect: item.effect,
        type: item.type,
        sub_type: item.sub_type,
        market_price: item.value?.market_price || 0,
        sell_price: item.value?.sell_price || 0,
        buy_price: item.value?.buy_price || 0,
        circulation: item.circulation,
        is_tradable: item.is_tradable,
        image_url: item.image,
        last_updated: new Date().toISOString()
    }));
    
    // Upsert in batches of 500
    const batchSize = 500;
    for (let i = 0; i < itemsToUpsert.length; i += batchSize) {
        const batch = itemsToUpsert.slice(i, i + batchSize);
        
        const { error } = await supabase
            .from('items')
            .upsert(batch, { onConflict: 'id' });
        
        if (error) {
            console.error(`Error upserting batch ${i / batchSize + 1}:`, error);
            throw error;
        }
        
        console.log(`Upserted batch ${i / batchSize + 1} of ${Math.ceil(itemsToUpsert.length / batchSize)}`);
    }
    
    console.log(`Successfully synced ${itemsToUpsert.length} items`);
}

syncItems().catch(console.error);