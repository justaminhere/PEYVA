# SYNTHETIC fixtures — not provider data

These files imitate the *shape* of the upstream tools' output, as read from the pinned
server sources (mrbilit-mcp 0.5.2 `flights.py`/`hotels.py`, flytoday-mcp 0.4.2 `flights.py`/`hotels.py`).
Every value (ids, prices, hotel names, times) is made up for unit tests and must never be
reported as a real flight, hotel or price. Replace them with sanitized real responses once a
live run succeeds from a network that can reach the providers.
