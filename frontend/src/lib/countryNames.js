/**
 * Radio-Browser labels countries with their formal name — "The United States Of
 * America", "The United Kingdom Of Great Britain And Northern Ireland" — which is
 * correct for matching a station to its country and wrong for anything a person
 * reads. This shortens a known set and sentence-cases the rest, and it is the same
 * list the build uses for the country pages (tools/prerender.mjs), so a chip and
 * the page it opens read the same.
 *
 * Display only: always pass the ORIGINAL name to handlers that filter stations.
 */
const ALIASES = {
  "the united kingdom of great britain and northern ireland": "United Kingdom",
  "the united states of america": "United States",
  "the united states minor outlying islands": "US Minor Outlying Islands",
  "the russian federation": "Russia",
  "the republic of korea": "South Korea",
  "the democratic peoples republic of korea": "North Korea",
  "the democratic republic of the congo": "DR Congo",
  "the central african republic": "Central African Republic",
  "bolivarian republic of venezuela": "Venezuela",
  "islamic republic of iran": "Iran",
  "syrian arab republic": "Syria",
  "taiwan, republic of china": "Taiwan",
  "the lao peoples democratic republic": "Laos",
  "the republic of moldova": "Moldova",
  "republic of north macedonia": "North Macedonia",
  "united republic of tanzania": "Tanzania",
  "federated states of micronesia": "Micronesia",
  "state of palestine": "Palestine",
  "brunei darussalam": "Brunei",
  "the falkland islands malvinas": "Falkland Islands",
  "the cocos keeling islands": "Cocos (Keeling) Islands",
  "ascension and tristan da cunha saint helena": "Saint Helena",
  "dutch part sint maarten": "Sint Maarten",
  "french part saint martin": "Saint Martin",
  "the french southern territories": "French Southern Territories",
};

export const prettyCountry = (raw) => {
  const cleaned = String(raw || "").trim();
  if (!cleaned) return "";
  const hit = ALIASES[cleaned.toLowerCase()];
  return (hit || cleaned.replace(/^the\s+/i, ""))
    .replace(/\s+And\s+/g, " and ")
    .replace(/\s+Of\s+/g, " of ")
    .replace(/\s+The\s+/g, " the ");
};

export default prettyCountry;
