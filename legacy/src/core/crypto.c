// Password hashing and CSPRNG via Windows CNG (bcrypt).
// windows.h must be included before bcrypt.h (MSYS2 header order).

#include <winsock2.h>
#include <windows.h>
#include <bcrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "crypto.h"

#define PW_ITERATIONS 60000
#define PW_SALT_LEN   16   // bytes
#define PW_HASH_LEN   32   // bytes (256-bit)

static const char HEX[] = "0123456789abcdef";

static void to_hex(const unsigned char *in, size_t len, char *out) {
    for (size_t i = 0; i < len; i++) {
        out[i * 2]     = HEX[in[i] >> 4];
        out[i * 2 + 1] = HEX[in[i] & 0x0f];
    }
    out[len * 2] = '\0';
}

static int from_hex(const char *in, unsigned char *out, size_t outlen) {
    for (size_t i = 0; i < outlen; i++) {
        char hi = in[i * 2], lo = in[i * 2 + 1];
        if (hi == '\0' || lo == '\0') return 0;
        int hv, lv;
        if (hi >= '0' && hi <= '9')      hv = hi - '0';
        else if (hi >= 'a' && hi <= 'f') hv = hi - 'a' + 10;
        else if (hi >= 'A' && hi <= 'F') hv = hi - 'A' + 10;
        else return 0;
        if (lo >= '0' && lo <= '9')      lv = lo - '0';
        else if (lo >= 'a' && lo <= 'f') lv = lo - 'a' + 10;
        else if (lo >= 'A' && lo <= 'F') lv = lo - 'A' + 10;
        else return 0;
        out[i] = (unsigned char)((hv << 4) | lv);
    }
    return 1;
}

int crypto_random_bytes(unsigned char *out, size_t len) {
    if (out == NULL || len == 0) return 0;
    return BCryptGenRandom(NULL, out, (ULONG)len,
                           BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0 ? 1 : 0;
}

int pw_hash(const char *password, char *out, size_t outsz) {
    if (password == NULL || out == NULL || outsz < PW_HASH_STORAGE_LEN) return 0;

    unsigned char salt[PW_SALT_LEN], hash[PW_HASH_LEN];
    if (!crypto_random_bytes(salt, sizeof(salt))) return 0;

    BCRYPT_ALG_HANDLE alg;
    if (BCryptOpenAlgorithmProvider(&alg, L"SHA256", NULL,
                                    BCRYPT_ALG_HANDLE_HMAC_FLAG) != 0) return 0;
    NTSTATUS st = BCryptDeriveKeyPBKDF2(alg,
        (unsigned char *)(uintptr_t)password, (ULONG)strlen(password),
        salt, sizeof(salt), PW_ITERATIONS,
        hash, sizeof(hash), 0);
    BCryptCloseAlgorithmProvider(alg, 0);
    if (st != 0) return 0;

    char salt_hex[PW_SALT_LEN * 2 + 1], hash_hex[PW_HASH_LEN * 2 + 1];
    to_hex(salt, sizeof(salt), salt_hex);
    to_hex(hash, sizeof(hash), hash_hex);
    snprintf(out, outsz, "pbkdf2-sha256$%d$%s$%s", PW_ITERATIONS, salt_hex, hash_hex);
    return 1;
}

// Constant-time comparison of two equal-length byte strings.
static int ct_equal(const unsigned char *a, const unsigned char *b, size_t len) {
    unsigned char diff = 0;
    for (size_t i = 0; i < len; i++) diff |= (unsigned char)(a[i] ^ b[i]);
    return diff == 0;
}

static int pbkdf2(const char *password, const unsigned char *salt, size_t saltlen,
                  unsigned long iterations, unsigned char *out, size_t outlen) {
    BCRYPT_ALG_HANDLE alg;
    if (BCryptOpenAlgorithmProvider(&alg, L"SHA256", NULL,
                                    BCRYPT_ALG_HANDLE_HMAC_FLAG) != 0) return 0;
    NTSTATUS st = BCryptDeriveKeyPBKDF2(alg,
        (unsigned char *)(uintptr_t)password, (ULONG)strlen(password),
        (unsigned char *)(uintptr_t)salt, (ULONG)saltlen, iterations, out, (ULONG)outlen, 0);
    BCryptCloseAlgorithmProvider(alg, 0);
    return st == 0 ? 1 : 0;
}

int pw_verify(const char *password, const char *stored) {
    if (password == NULL || stored == NULL || stored[0] == '\0') return 0;

    // Legacy plaintext (migrated data): stored has no hash prefix.
    if (strncmp(stored, "pbkdf2-sha256$", 14) != 0)
        return strcmp(password, stored) == 0;

    // pbkdf2-sha256$<iter>$<salt-hex>$<hash-hex>
    char fields[64], salt_hex[PW_SALT_LEN * 2 + 1] = {0};
    const char *p = stored + 14;
    const char *d1 = strchr(p, '$');
    if (!d1 || (size_t)(d1 - p) >= sizeof(fields)) return 0;
    memcpy(fields, p, (size_t)(d1 - p)); fields[d1 - p] = '\0';
    unsigned long iterations = strtoul(fields, NULL, 10);
    if (iterations < 1000 || iterations > 10000000) return 0;

    p = d1 + 1;
    const char *d2 = strchr(p, '$');
    if (!d2 || (size_t)(d2 - p) != PW_SALT_LEN * 2) return 0;
    memcpy(salt_hex, p, PW_SALT_LEN * 2);

    p = d2 + 1;
    size_t stored_hash_hex_len = strlen(p);
    if (stored_hash_hex_len != PW_HASH_LEN * 2) return 0;

    unsigned char salt[PW_SALT_LEN], stored_hash[PW_HASH_LEN], computed[PW_HASH_LEN];
    if (!from_hex(salt_hex, salt, sizeof(salt))) return 0;
    if (!from_hex(p, stored_hash, sizeof(stored_hash))) return 0;
    if (!pbkdf2(password, salt, sizeof(salt), iterations, computed, sizeof(computed))) return 0;

    return ct_equal(computed, stored_hash, PW_HASH_LEN);
}
