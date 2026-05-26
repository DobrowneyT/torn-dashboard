// Inline-SVG icons for the war-room quick-links bar. Inheriting `currentColor`
// + stroke-based design lets them blend with the surrounding text/button styles.
import { Swords, BriefcaseMedical, ShoppingBag, HeartPulse } from 'lucide-react'

export function FactionWarIcon({ className }) { return <Swords className={className} /> }
export function FactionMedicalIcon({ className }) { return <BriefcaseMedical className={className} /> }
export function ItemsIcon({ className }) { return <ShoppingBag className={className} /> }
export function RevivesIcon({ className }) { return <HeartPulse className={className} /> }