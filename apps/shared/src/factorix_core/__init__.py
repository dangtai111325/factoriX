"""FactoriX shared kernel: dependency-free helpers used by both Center and Acquisition (R2-E B1/B7).

Pure functions only (no I/O, no framework imports): UTC time formatting/parsing and TDengine SQL naming,
quoting and literal rendering. Callers that need their own exception types pass an error factory, so each
caller keeps raising exactly what it raised before the helpers were deduplicated.
"""
