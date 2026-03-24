"""
Unit conversion utilities for health and training data.
"""


def convert_kj_to_kcal(kj: float) -> int:
    """
    Convert kilojoules (mechanical work from power meter) to kilocalories.

    Formula: kcal = kJ / 4.184

    Note: This converts gross mechanical kJ output recorded by a power meter.
    For endurance cyclists, this approximates metabolic energy cost at roughly
    1 kJ mechanical ≈ 1 kcal metabolic due to ~25% gross mechanical efficiency
    — i.e. the body burns ~4 kcal to produce 1 kJ of mechanical work, but the
    conventional shorthand used in sports nutrition treats kJ output ≈ kcal burned
    as a practical working estimate. This is NOT the same as a precise metabolic
    measurement; it understates true caloric cost by roughly 20-25%.

    Returns:
        Nearest whole number kcal.
    """
    return round(kj / 4.184)
