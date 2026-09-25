// x402-paid current weather. Live data from Open-Meteo; the payment is a real testnet settlement.
import { getJson, paywall } from "@/lib/x402";

// WMO weather codes, collapsed
function conditions(code: number) {
  if (code === 0) return "clear";
  if (code <= 3) return "cloudy";
  if (code <= 48) return "fog";
  if (code <= 67 || (code >= 80 && code <= 82)) return "rain";
  if (code <= 77 || code === 85 || code === 86) return "snow";
  return "thunderstorm";
}

async function weather(city: string) {
  const geo = await getJson<{ results?: { name: string; country: string; latitude: number; longitude: number }[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`);
  const place = geo.results?.[0];
  if (!place) return null;
  const { current: c } = await getJson<{ current: { temperature_2m: number; weather_code: number; wind_speed_10m: number } }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code,wind_speed_10m`);
  const sky = conditions(c.weather_code);
  return {
    city: `${place.name}, ${place.country}`,
    temperatureC: c.temperature_2m,
    conditions: sky,
    windKmh: c.wind_speed_10m,
    summary: `${Math.round(c.temperature_2m)}°C, ${sky}, wind ${Math.round(c.wind_speed_10m)} km/h`,
    source: "Open-Meteo",
  };
}

export async function GET(req: Request) {
  const city = (new URL(req.url).searchParams.get("city") ?? "").trim().slice(0, 60);
  if (!city) return Response.json({ error: "city required" }, { status: 400 });
  return paywall(req, "weather", `Weather for ${city}`, () => weather(city));
}
