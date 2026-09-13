// Unit tests for the crypto module (pw_hash / pw_verify).
// Runs entirely offline — no database, no server.

#include <stdio.h>
#include <string.h>
#include "src/core/crypto.h"

static int tests_run, tests_failed;

#define CHECK(cond) do { \
    if (!(cond)) { printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); tests_failed++; } \
} while (0)

#define RUN(name) do { printf("[RUN ] %s\n", name); tests_run++; } while (0)

int main(void) {
    RUN("hash then verify round-trips");
    char stored[PW_HASH_STORAGE_LEN];
    CHECK(pw_hash("correct horse", stored, sizeof(stored)) == 1);
    CHECK(strncmp(stored, "pbkdf2-sha256$", 14) == 0);
    CHECK(pw_verify("correct horse", stored) == 1);

    RUN("wrong password rejected");
    CHECK(pw_verify("wrong horse", stored) == 0);
    CHECK(pw_verify("", stored) == 0);
    CHECK(pw_verify("correct hors", stored) == 0);
    CHECK(pw_verify("correct horse ", stored) == 0);

    RUN("each hash uses a fresh salt");
    char stored2[PW_HASH_STORAGE_LEN];
    CHECK(pw_hash("correct horse", stored2, sizeof(stored2)) == 1);
    CHECK(strcmp(stored, stored2) != 0);              // different salt -> different hash
    CHECK(pw_verify("correct horse", stored2) == 1);  // but both verify

    RUN("tampered stored fields rejected");
    char tampered[PW_HASH_STORAGE_LEN];
    snprintf(tampered, sizeof(tampered), "%s", stored);
    tampered[20] ^= 0x01;                              // flip a salt char
    CHECK(pw_verify("correct horse", tampered) == 0);
    snprintf(tampered, sizeof(tampered), "%s", stored);
    { char *last = strrchr(tampered, '$'); last[5] ^= 0x01; }  // flip a hash char
    CHECK(pw_verify("correct horse", tampered) == 0);

    RUN("malformed stored strings rejected");
    CHECK(pw_verify("x", "pbkdf2-sha256$abc$00$00") == 0);          // bad iterations
    CHECK(pw_verify("x", "pbkdf2-sha256$60000$zz$00") == 0);        // bad salt hex
    CHECK(pw_verify("x", "pbkdf2-sha256$60000$") == 0);             // truncated
    CHECK(pw_verify("x", "") == 0);
    CHECK(pw_verify("x", "plaintext-legacy") == 0);                 // legacy mismatch
    CHECK(pw_verify("plaintext-legacy", "plaintext-legacy") == 1);  // legacy match

    RUN("CSPRNG produces distinct buffers");
    unsigned char a[16], b[16];
    CHECK(crypto_random_bytes(a, sizeof(a)) == 1);
    CHECK(crypto_random_bytes(b, sizeof(b)) == 1);
    CHECK(memcmp(a, b, sizeof(a)) != 0);

    printf("\n%d test(s) run, %d assertion failure(s)\n", tests_run, tests_failed);
    return tests_failed ? 1 : 0;
}
