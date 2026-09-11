// Password hashing (PBKDF2-HMAC-SHA256) and CSPRNG — Node.js built-in crypto.
// Stored format: pbkdf2-sha256$<iterations>$<salt-hex>$<hash-hex>

const crypto = require('crypto');

const ITERATIONS = 60000;
const SALT_LEN  = 16;   // bytes
const HASH_LEN  = 32;   // bytes (256-bit)

function pwHash(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, HASH_LEN, 'sha256');
  return `pbkdf2-sha256$${ITERATIONS}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function pwVerify(password, stored) {
  if (!password || !stored) return false;

  // Legacy plaintext (migrated data).
  if (!stored.startsWith('pbkdf2-sha256$')) {
    return password === stored;
  }

  // Parse: pbkdf2-sha256$<iter>$<salt-hex>$<hash-hex>
  const parts = stored.split('$');
  if (parts.length !== 4) return false;

  const iterations = parseInt(parts[1], 10);
  if (isNaN(iterations) || iterations < 1000 || iterations > 10000000) return false;

  const salt = Buffer.from(parts[2], 'hex');
  const storedHash = Buffer.from(parts[3], 'hex');
  if (salt.length !== SALT_LEN || storedHash.length !== HASH_LEN) return false;

  const computed = crypto.pbkdf2Sync(password, salt, iterations, HASH_LEN, 'sha256');
  return crypto.timingSafeEqual(computed, storedHash);
}

function randomBytes(len) {
  return crypto.randomBytes(len);
}

module.exports = { pwHash, pwVerify, randomBytes };
