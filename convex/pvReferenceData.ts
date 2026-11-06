// ---------------------------------------------------------------------------
// Reference safety information (a stand-in for a product's approved label /
// core data sheet) for three fictional products, used to determine
// "expectedness" — whether a reported adverse event is already listed for
// that product. Deliberately generic, non-brand-like names ("Product A/B/C")
// rather than invented drug names: this is a workflow demo, not a company
// site, and generic labels carry zero risk of colliding with a real product.
//
// This lives outside convex/schema.ts because it's plain reference data, not
// something reports get inserted into — see convex/ae.ts for how it's used.
// ---------------------------------------------------------------------------

export interface ProductRef {
  id: string
  name: string
  description: string
  /** Adverse event terms already listed in this product's reference safety
   * information — matched case-insensitively against a reporter's free-text
   * event term. */
  knownEvents: string[]
}

export const PRODUCTS: ProductRef[] = [
  {
    id: "product-a",
    name: "Product A (oral tablet)",
    description: "Oral small-molecule therapy, once-daily dosing.",
    knownEvents: ["nausea", "headache", "fatigue", "diarrhea", "dizziness"],
  },
  {
    id: "product-b",
    name: "Product B (injectable)",
    description: "Subcutaneous biologic, administered every two weeks.",
    knownEvents: ["injection site reaction", "injection site pain", "mild fever", "upper respiratory infection"],
  },
  {
    id: "product-c",
    name: "Product C (topical)",
    description: "Topical formulation for localized application.",
    knownEvents: ["application site irritation", "mild erythema", "pruritus"],
  },
]

export function findProduct(productId: string): ProductRef | undefined {
  return PRODUCTS.find((p) => p.id === productId)
}

// ---------------------------------------------------------------------------
// Event-term normalisation. Reporters use lay language ("throwing up"); the
// product label uses clinical terms ("vomiting"). Mapping lay phrases to a
// canonical term before the expectedness check stops a listed event being
// wrongly flagged as unexpected (and an unlisted one slipping through as
// expected). This is a small illustrative dictionary, not MedDRA coding.
// ---------------------------------------------------------------------------
const SYNONYMS: Record<string, string> = {
  "throwing up": "vomiting",
  "being sick": "vomiting",
  "feeling sick": "nausea",
  "sick to my stomach": "nausea",
  "queasy": "nausea",
  "tired": "fatigue",
  "tiredness": "fatigue",
  "exhaustion": "fatigue",
  "head ache": "headache",
  "sore head": "headache",
  "loose stools": "diarrhea",
  "diarrhoea": "diarrhea",
  "dizzy": "dizziness",
  "light headed": "dizziness",
  "lightheadedness": "dizziness",
  "itching": "pruritus",
  "itchy skin": "pruritus",
  "rash": "skin rash",
  "redness": "mild erythema",
  "erythema": "mild erythema",
  "fever": "mild fever",
  "pain at injection site": "injection site pain",
  "injection site redness": "injection site reaction",
  "skin irritation": "application site irritation",
  "passed out": "syncope",
  "fainting": "syncope",
}

export function canonicalTerm(raw: string): string {
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ")
  return SYNONYMS[t] ?? t
}

/** Common terms offered as suggestions alongside the product's listed events. */
export const COMMON_EVENT_TERMS = [
  "abdominal pain", "anaphylaxis", "angioedema", "anxiety", "arthralgia", "back pain", "cough",
  "constipation", "dyspnea", "hepatotoxicity", "hypertension", "hypotension", "insomnia", "myalgia",
  "palpitations", "seizure", "skin rash", "somnolence", "syncope", "tachycardia", "urticaria", "vomiting",
]

export function eventTermSuggestions(product: { knownEvents: string[] }): string[] {
  return [...new Set([...product.knownEvents, ...COMMON_EVENT_TERMS])].sort((a, b) => a.localeCompare(b))
}
