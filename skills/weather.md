---
name: weather
description: Check weather for any location
always: false
requires:
  env: [WEATHER_API_KEY]
---

## Instructions
When the user asks about weather, use the `get_weather` tool to fetch current conditions.
Format the response with temperature, conditions, and humidity.

## Tools
### get_weather
Get current weather for a location.
Parameters:
- location (string, required): City name or coordinates
