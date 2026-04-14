#!/usr/bin/env python3
import asyncio
import sys

sys.path.insert(0, ".")
from browser_client import browse_url


async def test():
    result = await browse_url("https://www.google.com")
    print("Browser test result:", result)


asyncio.run(test())
