#ifndef CORE_CRYPTO_H
#define CORE_CRYPTO_H

#include <stddef.h>

// Password hashing (PBKDF2-HMAC-SHA256 via Windows CNG) and CSPRNG tokens.
//
// Stored format:  pbkdf2-sha256$<iterations>$<salt-hex>$<hash-hex>
// Verification parses that format and recomputes; strings without the
// prefix (legacy plaintext/migrated passwords) are compared as-is so old
// data keeps working until re-hashed on first successful login.

#define PW_HASH_STORAGE_LEN 160   // max storage size for a hashed password

// Hash `password` with a fresh random 16-byte salt, PBKDF2-SHA256,
// PW_ITERATIONS rounds. Writes a self-describing string (see format above)
// into `out` (capacity PW_HASH_STORAGE_LEN). Returns 1 on success.
int pw_hash(const char *password, char *out, size_t outsz);

// Verify `password` against a stored hash or legacy plaintext.
// Returns 1 on match, 0 on mismatch/error.
int pw_verify(const char *password, const char *stored);

// CSPRNG: fill `out` with `len` cryptographically random bytes.
// Returns 1 on success.
int crypto_random_bytes(unsigned char *out, size_t len);

#endif // CORE_CRYPTO_H
