const weather = require("./weather");

const hour = (h, extra = {}) => ({
	startTime: `2026-10-10T${String(h).padStart(2, "0")}:00:00-04:00`,
	endTime: `2026-10-10T${String(h + 1).padStart(2, "0")}:00:00-04:00`,
	temperature: 50 + h,
	temperatureUnit: "F",
	probabilityOfPrecipitation: { value: h >= 18 ? 60 : 10 },
	windSpeed: "5 mph",
	shortForecast: h >= 18 ? "Rain Showers" : "Sunny",
	...extra,
});

beforeEach(() => {
	const periods = Array.from({ length: 12 }, (_, i) => hour(10 + i));
	global.fetch = jest.fn(async (url) => ({
		ok: true,
		json: async () =>
			url.includes("/points/")
				? { properties: { forecastHourly: "https://api.weather.gov/gridpoints/X/1,2/forecast/hourly", relativeLocation: { properties: { city: "Westlake", state: "OH" } } } }
				: { properties: { periods } },
	}));
});

test("from now by default, the same shape as before", async () => {
	const sky = await weather.forecast(41.1, -81.1, { hours: 3 });
	expect(sky.place).toBe("Westlake, OH");
	expect(sky.hours.map((h) => h.temperatureF)).toEqual([60, 61, 62]);
	expect(sky.outdoorOutlook).toBe("fine");
});

test("from a time: the hour containing it onward, read from the cached week", async () => {
	const sky = await weather.forecast(41.1, -81.1, { hours: 2, from: "2026-10-10T17:30:00-04:00" });
	expect(sky.hours.map((h) => h.start)).toEqual(["2026-10-10T17:00:00-04:00", "2026-10-10T18:00:00-04:00"]);
	expect(sky.outdoorOutlook).toBe("wet");
	// Second call for the same point used the cache.
	expect(global.fetch).not.toHaveBeenCalled();
});

test("past the end of the forecast is null, never a guess", async () => {
	expect(await weather.forecast(41.2, -81.2, { from: "2026-10-20T12:00:00-04:00" })).toBeNull();
});
