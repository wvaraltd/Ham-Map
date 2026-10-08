# SOTA live spots integration — approval pending

SOTA's spotting service (SOTAwatch) and summit reference data are the intended sources. Do not poll the SOTA API until the SOTA team grants permission and confirms the current supported endpoints, rate limits, and permitted caching.

## Proposed pipeline
1. Server-side HTTPS fetch with explicit user agent, bounded timeout, retry backoff, and 60–120-second cache; never call the provider directly from every browser.
2. Validate and normalize recent spots into `{activator, summitCode, frequency, mode, spottedAt}`. Reject stale, invalid or duplicate entries.
3. Resolve summit codes to latitude/longitude using a licensed, periodically refreshed local summit index. Do not invent coordinates or infer them from callsigns.
4. Return `{spots:[{activator,summitCode,frequency,mode,latitude,longitude,spottedAt}]}` to `/api/live/sota`.
5. If permission, data or coordinates are unavailable, return an empty feed with explicit status; do not show fictional activators.

## Approval request
To: SOTA API / SOTAwatch administrators (via official SOTA website contact)
Subject: Permission to integrate SOTAwatch live spots into ARA Ham Map

Hello,

I maintain ARA Ham Map, an amateur-radio map at https://porker.ara.radio/. We would like permission to display recent SOTA activator spots on our map, similar to our existing POTA activator layer. The integration will be server-side, use a single shared cache (proposed 60–120 seconds), identify our application, and respect your specified rate limits and attribution requirements. We also want to resolve summit references to coordinates using an authorized summit database.

Please advise the currently supported API endpoints, licensing/attribution, permitted caching, developer registration requirements, and any other conditions. The implementation is AI-assisted and will not access the live service until authorized.

Thank you,
ARA Ham Map team

## Sample fixture
`fixtures/sota-spots.example.json` contains illustrative non-live records for local integration tests only; never label them as live on the public map.
