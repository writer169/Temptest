import { saveTemperatureData } from '../../lib/mongodb';

// ВАЖНО: Мы убрали 'export const config = { runtime: 'edge' };'
// Теперь код будет выполняться в стандартной среде Node.js, где req.query работает.

export default async function handler(req, res) {
  // 1. Проверки безопасности и метода запроса
  const { uuid } = req.query; // Этот синтаксис теперь корректен
  if (!uuid || uuid !== process.env.UUID) {
    return res.status(403).json({ error: 'Недопустимый UUID' });
  }

  if (req.method !== 'POST') {
     return res.status(405).json({ error: 'Метод не разрешен' });
  }

  try {
    // 2. Расчет времени
    const now = new Date();
    const currentTimeUTC5 = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    const currentHour = new Date(currentTimeUTC5);
    currentHour.setMinutes(0, 0, 0);

    const forecastTargetTime = new Date(currentHour.getTime() + 12 * 60 * 60 * 1000);

    // 3. ПАРАЛЛЕЛЬНОЕ ВЫПОЛНЕНИЕ ВСЕХ СЕТЕВЫХ ЗАПРОСОВ
    const [
      narodmonResult,
      yandexResult,
      meteoResult
    ] = await Promise.allSettled([
      fetch(`https://narodmon.ru/api?cmd=sensorsValues&sensors=37687&uuid=${process.env.NARODMON_UUID}&api_key=${process.env.NARODMON_KEY}`).then(r => r.json()),
      fetch('https://api.weather.yandex.ru/v2/forecast?lat=43.23&lon=76.86', { headers: { 'X-Yandex-Weather-Key': process.env.YANDEX_KEY } }).then(r => r.json()),
      fetch('https://api.open-meteo.com/v1/forecast?latitude=43.23&longitude=76.86&timezone=auto&hourly=temperature_2m&models=ecmwf_aifs025_single').then(r => r.json())
    ]);

    // 4. Обработка результатов
    
    // Narodmon (критически важный запрос)
    if (narodmonResult.status === 'rejected' || !narodmonResult.value.sensors?.[0]?.value) {
      console.error('Ошибка получения данных Narodmon:', narodmonResult.reason || 'Данные сенсора недоступны');
      throw new Error('Критическая ошибка: не удалось получить данные с сенсора Narodmon.');
    }
    const actualTemp = Number(narodmonResult.value.sensors[0].value);
    
    // Yandex Weather
    let yandexForecast = null;
    if (yandexResult.status === 'fulfilled') {
      const yandexData = yandexResult.value;
      const targetDate = forecastTargetTime.toISOString().split('T')[0];
      const targetHour = forecastTargetTime.getHours();
      const forecast = yandexData.forecasts?.find(f => f.date === targetDate);
      if (forecast?.hours) {
        const hourData = forecast.hours.find(h => parseInt(h.hour) === targetHour);
        if (hourData?.temp !== undefined) {
          yandexForecast = Number(hourData.temp);
        }
      }
    } else {
      console.error('Ошибка получения прогноза Yandex:', yandexResult.reason);
    }
    
    // Open-Meteo
    let meteoForecast = null;
    if (meteoResult.status === 'fulfilled') {
      const meteoData = meteoResult.value;
      const targetTimeForMeteo = forecastTargetTime.toISOString().substring(0, 13) + ':00';
      const timeIndex = meteoData.hourly?.time?.findIndex(time => time === targetTimeForMeteo);
      if (timeIndex > -1 && meteoData.hourly?.temperature_2m?.[timeIndex] !== undefined) {
        meteoForecast = Number(meteoData.hourly.temperature_2m[timeIndex]);
      }
    } else {
      console.error('Ошибка получения прогноза Open-Meteo:', meteoResult.reason);
    }

    // 5. ПАРАЛЛЕЛЬНАЯ ЗАПИСЬ В БАЗУ ДАННЫХ
    await Promise.all([
        saveTemperatureData(currentHour, { actual: actualTemp }),
        saveTemperatureData(forecastTargetTime, {
            yandex_forecast: yandexForecast,
            meteo_forecast: meteoForecast
        })
    ]);

    // 6. Отправка успешного ответа
    return res.status(200).json({
      success: true,
      actual: actualTemp,
      yandex_forecast: yandexForecast,
      meteo_forecast: meteoForecast,
      target_time: forecastTargetTime.toISOString(),
    });

  } catch (error) {
    console.error('Общая ошибка в API-маршруте collect:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}
