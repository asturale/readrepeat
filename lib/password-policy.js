// NIST SP 800-63B-style policy: prioritize length over forced character-
// class complexity rules (those push people toward predictable
// substitutions like "P@ssw0rd1" rather than actually stronger passwords),
// but still reject the most common/breached passwords outright.
export const MIN_LENGTH = 12;

// Every entry here must be >= MIN_LENGTH -- anything shorter is already
// rejected by the length check above it, so a shorter "common password"
// would be dead code (caught the hard way: the first version of this list
// was entirely < 12 chars long and this check never actually ran).
const COMMON_PASSWORDS = new Set(
    [
        'password1234', 'password123!', 'passw0rd1234', 'p@ssw0rd1234',
        '123456789012', '1234567890123', '12345678901234',
        'qwertyuiop123', 'qwertyqwerty', 'qwertyuiopasdf', '1qaz2wsx3edc', 'zaq12wsx3edc',
        'iloveyou1234', 'letmein12345', 'welcome12345', 'admin12345678',
        'sunshine12345', 'princess12345', 'football12345', 'baseball12345',
        'dragon1234567', 'monkey1234567', 'trustno12345', 'changeme12345',
        'superman12345', 'starwars12345', 'whatever12345', 'monkeybusiness',
        'aaaaaaaaaaaa', '111111111111', '000000000000', 'abcdefghijkl',
        'asdfasdfasdf', 'abcabcabcabc', 'correcthorsebatterystaple',
    ].map((p) => p.toLowerCase())
);

// Returns null when the password is acceptable, otherwise a reason code
// ('too_short' | 'too_common') for the caller to translate into a message.
export function checkPasswordStrength(password) {
    if (!password || password.length < MIN_LENGTH) return 'too_short';
    if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'too_common';
    return null;
}
