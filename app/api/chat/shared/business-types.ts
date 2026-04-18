/** Business type knowledge base.
 *
 * Each vertical has services, emergency examples, pricing context, and seasonal
 * info that gets injected into every demo's system prompt.
 */

import type { BusinessType, UrgencyLevel } from "./types"

export interface BusinessTypeConfig {
  id: BusinessType
  label: string
  services: string[]
  emergencyExamples: string[]
  avgJobValue: number
  urgencyKeywords: Record<UrgencyLevel, string[]>
  pricingContext: string
  seasonalContext: string
  commonObjections: string[]
  reviewTopics: string[]
}

export const BUSINESS_TYPE_CONFIGS: Record<BusinessType, BusinessTypeConfig> = {
  hvac: {
    id: "hvac",
    label: "HVAC",
    services: ["AC repair", "furnace install", "duct cleaning", "heat pump", "thermostat", "refrigerant recharge", "air handler", "compressor replacement"],
    emergencyExamples: ["no AC in summer", "no heat in winter", "burning smell from vents", "carbon monoxide alarm", "gas smell near furnace"],
    avgJobValue: 1200,
    urgencyKeywords: {
      emergency: ["no ac", "no heat", "no cooling", "no heating", "burning smell", "gas smell", "carbon monoxide", "frozen pipe"],
      same_day: ["strange noise", "not cooling well", "warm air", "running constantly", "ice on unit", "water dripping", "thermostat broken"],
      normal: ["tune up", "maintenance", "inspection", "estimate", "new unit", "upgrade", "duct cleaning"],
      low: ["thinking about", "next year", "just curious", "how much would"],
    },
    pricingContext: "Average HVAC service call: $150-$400. AC repair: $200-$1,500. Full system replacement: $5,000-$12,000.",
    seasonalContext: "Summer = peak AC demand, wait times increase. Winter = furnace season. Spring/fall = best time for maintenance.",
    commonObjections: ["got a cheaper quote", "my buddy does HVAC", "just had it serviced", "want to wait and see", "too expensive"],
    reviewTopics: ["technician professionalism", "pricing transparency", "response speed", "quality of repair", "warranty coverage"],
  },
  plumbing: {
    id: "plumbing",
    label: "Plumbing",
    services: ["drain cleaning", "water heater", "leak repair", "sewer line", "toilet repair", "faucet install", "pipe repair", "sump pump", "garbage disposal"],
    emergencyExamples: ["burst pipe", "sewage backup", "no hot water", "flooding", "gas line leak", "water main break"],
    avgJobValue: 800,
    urgencyKeywords: {
      emergency: ["burst pipe", "flooding", "sewage", "sewer backup", "no water", "gas leak", "water main"],
      same_day: ["leak", "dripping", "slow drain", "clogged", "running toilet", "no hot water", "water heater"],
      normal: ["install", "replace", "upgrade", "estimate", "faucet", "disposal", "remodel"],
      low: ["thinking about", "eventually", "quote for future", "bathroom remodel planning"],
    },
    pricingContext: "Average plumbing service call: $100-$300. Drain cleaning: $150-$500. Water heater: $800-$2,500.",
    seasonalContext: "Winter = frozen pipes and water heater failures. Holiday season = garbage disposal issues. Spring = sewer line problems.",
    commonObjections: ["found someone cheaper", "going to try fixing it myself", "landlord should pay", "just want a quote"],
    reviewTopics: ["response time", "cleanliness", "pricing", "fix quality", "communication"],
  },
  electrical: {
    id: "electrical",
    label: "Electrical",
    services: ["panel upgrade", "outlet repair", "lighting install", "wiring", "ceiling fan", "EV charger", "generator install", "circuit breaker"],
    emergencyExamples: ["sparking outlet", "burning smell", "no power", "exposed wiring", "electrical fire", "buzzing panel"],
    avgJobValue: 600,
    urgencyKeywords: {
      emergency: ["sparking", "burning smell", "no power", "exposed wire", "electrical fire", "buzzing", "smoking"],
      same_day: ["outlet not working", "breaker keeps tripping", "lights flickering", "half house no power"],
      normal: ["panel upgrade", "new outlet", "ceiling fan", "EV charger", "lighting", "rewire"],
      low: ["estimate", "thinking about solar", "future renovation", "quote for panel"],
    },
    pricingContext: "Average electrical service call: $100-$250. Panel upgrade: $1,500-$4,000. EV charger: $500-$2,000.",
    seasonalContext: "Storm season = power outage calls. Summer = AC-related electrical issues. Holiday = lighting installs.",
    commonObjections: ["handyman quoted less", "not sure I need a licensed electrician", "going to wait", "insurance should cover it"],
    reviewTopics: ["safety", "code compliance", "neatness", "explanation of work", "pricing"],
  },
  roofing: {
    id: "roofing",
    label: "Roofing",
    services: ["roof repair", "full replacement", "leak repair", "gutter install", "shingle replacement", "storm damage", "inspection", "skylight"],
    emergencyExamples: ["active roof leak during rain", "tree fell on roof", "missing shingles after storm", "ceiling collapsing"],
    avgJobValue: 3500,
    urgencyKeywords: {
      emergency: ["active leak", "tree on roof", "ceiling caving", "storm damage", "hole in roof", "collapsed"],
      same_day: ["leak", "missing shingles", "water stain ceiling", "insurance inspection", "storm just hit"],
      normal: ["replacement quote", "inspection", "gutters", "re-roof", "maintenance"],
      low: ["thinking about selling", "someday", "just checking prices", "neighbor got theirs done"],
    },
    pricingContext: "Average roof repair: $300-$1,500. Full replacement: $8,000-$25,000. Gutter install: $1,000-$3,000.",
    seasonalContext: "Spring/fall = peak roofing season. Post-storm = emergency surge. Winter = slower, off-season discounts.",
    commonObjections: ["got three quotes already", "insurance company is difficult", "want to wait until spring", "roof looks fine from the ground"],
    reviewTopics: ["quality of materials", "cleanup", "timeline", "insurance help", "crew professionalism"],
  },
  general: {
    id: "general",
    label: "General Home Services",
    services: ["handyman", "painting", "flooring", "pressure washing", "pest control", "landscaping", "garage door", "fence repair", "concrete"],
    emergencyExamples: ["garage door stuck open", "broken window", "pest infestation", "tree down in yard"],
    avgJobValue: 500,
    urgencyKeywords: {
      emergency: ["broken into", "stuck open", "infestation", "tree down", "broken window", "flooding yard"],
      same_day: ["pest problem", "broken door", "clogged gutter", "tripping hazard", "unsafe step"],
      normal: ["painting", "flooring", "fence", "pressure wash", "landscaping", "estimate"],
      low: ["spring cleaning", "curb appeal", "thinking about", "someday", "quote for"],
    },
    pricingContext: "Varies widely by service. Handyman: $75-$200/hr. Painting: $2,000-$6,000. Pest control: $100-$500.",
    seasonalContext: "Spring = outdoor projects surge. Summer = landscaping peak. Fall = winterization prep.",
    commonObjections: ["I can do it myself", "found someone on TaskRabbit", "just comparing prices", "not a priority right now"],
    reviewTopics: ["quality of work", "punctuality", "communication", "value for money", "attention to detail"],
  },
}

/** Build a prompt-injectable business context block. */
export function getBusinessContext(businessType: BusinessType): string {
  const config = BUSINESS_TYPE_CONFIGS[businessType]
  return `BUSINESS TYPE: ${config.label}
COMMON SERVICES: ${config.services.slice(0, 6).join(", ")}
EMERGENCY EXAMPLES: ${config.emergencyExamples.join(", ")}
PRICING: ${config.pricingContext}
SEASONAL: ${config.seasonalContext}`
}
