# Provider credentials live in our own credential store, not pi's auth.json

Model-provider credentials (API keys and subscription OAuth tokens) are stored through our own implementation of pi-ai's `CredentialStore`, encrypted in the OpenBot database alongside plugin credentials, rather than in pi's plaintext `auth.json`. pi-ai refreshes OAuth tokens through any store, so nothing is lost; the file-backed store lives in the pi CLI package and isn't exported anyway; and keeping every system credential in one encrypted place gives one backup unit, one audit trail and one rule: no API or tool ever returns a system credential.

## Consequences

- There is no compatibility with the pi CLI's `auth.json`, and no import from it.
