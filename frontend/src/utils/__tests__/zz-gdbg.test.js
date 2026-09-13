import { describe, it } from 'vitest'
import { computeGuidance, makeProbe } from '../ocGuidancePipeline'
const ROLES = [
  { position_id:'P1', role_name:'A', weight:34.6 }, { position_id:'P2', role_name:'B', weight:30 },
  { position_id:'P3', role_name:'C', weight:32.5 }, { position_id:'P4', role_name:'D', weight:2.9 }]
const ROOT = { name:'Stacking the Deck', roles:ROLES, endings:[
  { ending_key:'goodEnding1', kind:'good', resolved:true, node_id:'A', money_avg:null, reward:{money:null,chainsTo:'Ace in the Hole'} },
  { ending_key:'badEnding1', kind:'bad', resolved:true, node_id:'F' } ] }
const TERM = { name:'Ace in the Hole', roles:[...ROLES,{position_id:'P5',role_name:'E',weight:0}], endings:[
  { ending_key:'goodEnding1', kind:'good', resolved:true, node_id:'A', money_avg:500_000_000 },
  { ending_key:'badEnding1', kind:'bad', resolved:true, node_id:'F' } ] }
const rawFor = (p) => { const avg=p.reduce((a,b)=>a+b,0)/p.length; const g=Math.min(0.95,Math.max(0,(avg-50)/50))
  return { successChance:g, failureChance:1-g, goodEnding1:g, badEnding1:1-g, goodEnding9:0 } }
const pool = Array.from({length:12},(_,i)=>({member_id:`m${i}`,cpr:95-i}))
const rc = { readings: Object.fromEntries(ROLES.map(r=>[r.position_id,pool.map(x=>({...x}))])), roster_size:40 }
describe('gdbg',()=>{ it('dumps',async()=>{
  const rootProbe = makeProbe({ scenario: ROOT, call: async (n,p)=>rawFor(p) })
  console.log('  root probe at 90s:', JSON.stringify(await rootProbe({P1:90,P2:90,P3:90,P4:90})))
  const out = await computeGuidance({ scenario:ROOT, rosterCpr:rc, category:{scopeCost:5,scopeReward:6},
    call: async (n,p)=>rawFor(p), scenarios:[ROOT,TERM],
    chains:[{parent:'Stacking the Deck',child:'Ace in the Hole',observations:128}],
    categoryOf:()=> 'elaborate', now:()=>'x' })
  console.log('  reason:', out.reason, ' publishable:', out.guidance.publishable, ' chainCtx:', out.chainContext ? 'present' : 'null')
  console.log('  search reason:', out.search?.reason, ' rejected:', JSON.stringify((out.search?.rejected??[]).map(r=>r.reason)))
})})
