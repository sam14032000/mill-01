CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
CHAR_MAP = {c: i for i, c in enumerate(CHARS)}

def calculate_gstin_checksum(gstin_14: str) -> str:
    """Calculates the 15th checksum character using standard GSTN Mod-36 algorithm."""
    total = 0
    for i, char in enumerate(gstin_14.upper()):
        val = CHAR_MAP[char]
        factor = 1 if (i % 2 == 0) else 2
        prod = val * factor
        total += (prod // 36) + (prod % 36)
    check_val = (36 - (total % 36)) % 36
    return CHARS[check_val]

def is_valid_gstin(gstin: str) -> bool:
    """Validates 15-character GSTIN format and mod-36 checksum."""
    if not isinstance(gstin, str) or len(gstin) != 15:
        return False
    gstin = gstin.upper()
    if not all(c in CHAR_MAP for c in gstin):
        return False
    expected_check = calculate_gstin_checksum(gstin[:14])
    return gstin[14] == expected_check

# 20 deliberately malformed GSTIN samples (typos, swapped digits, bad check digit, invalid chars)
MALFORMED_SAMPLES = [
    ("27AAPFU0939F1ZV", "Corrupted checksum digit (V instead of Z)"),
    ("29ABCDE1234F1Z5", "Arbitrary invalid check character 5"),
    ("07AAAAA0000A1Z9", "Off-by-one check character"),
    ("33GSPTN1234M1Z0", "Incorrect state prefix calculation"),
    ("27AAPFU0939F1ZZ", "Duplicate last char"),
    ("29ABCDE1234F1ZA", "Random alpha check digit"),
    ("06AAACH7409R1Z1", "Altered PAN number without check update"),
    ("19AAACB2066P1Z3", "Single digit transposition in entity code"),
    ("24AAACC1206D1Z2", "Invalid check char"),
    ("36AAACR4846L1Z4", "Modified PAN alphanumeric body"),
    ("27AAAPL1234C1Z0", "Mismatched checksum"),
    ("08AABCB1234P1Z8", "Corrupted entity number"),
    ("10AAACZ9999K1Z7", "Off-by-two check char"),
    ("32AAAAA1111A1Z1", "Malformed checksum suffix"),
    ("21AAACG0500P1Z6", "Altered serial character"),
    ("03AAACB1000P1Z2", "Swapped internal digit"),
    ("22AAAAA9999A1Z8", "Corrupted checksum"),
    ("23ABCDE5678F1ZQ", "Invalid check letter Q"),
    ("09AAACH1111R1Z9", "Modified entity index"),
    ("18AAACR0001L1Z0", "Invalid terminal checksum digit")
]

if __name__ == "__main__":
    flagged_invalid = 0
    total = len(MALFORMED_SAMPLES)

    print(f"Testing {total} deliberately malformed GST numbers...\n")
    for gstin, desc in MALFORMED_SAMPLES:
        valid = is_valid_gstin(gstin)
        status = "PASSED (Incorrectly accepted)" if valid else "FLAGGED (Correctly rejected)"
        if not valid:
            flagged_invalid += 1
        print(f"[{status}] {gstin} -> {desc}")

    detection_rate = (flagged_invalid / total) * 100
    print(f"\nResults: {flagged_invalid}/{total} flagged as invalid ({detection_rate:.1f}%).")
    print(f"Assumption (>=90% detection): {'CONFIRMED' if detection_rate >= 90 else 'FAILED'}")
