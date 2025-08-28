import { saveTemperatureData } from '../../lib/mongodb';

// Включаем эту опцию, чтобы Vercel использовал более быстрый Edge Runtime, если это возможно.
// Если у вас есть зависимости, несовместимые с Edge, удалите эту строку.
export const config = {
  runtime: 'edge', // или 'nodejs' (по умолчанию)
};

export default async function handler(req, res) {
  // 1. Проверки безопасности и метода запроса
  const { uuid } from req.query;
  if (!uuid || uuid !== process.env.UUID) {
    return new Response(JSON.stringify({ error: 'Недопустимый UUID' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  // В Edge Runtime `req.method` находится в объекте `Request`, а не `NextApiRequest`.
  if (req.method !== 'POST') {
     return new Response(JSON.stringify({ error: 'Метод не разрешен' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    // 2. Расчет времени
    const now = new Date();
    const currentTimeUTC5 = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    const currentHour = new Date(currentTimeUTC5);
    currentHour.setMinutes(0, 0, 0);

    const forecastTargetTime = new Date(currentHour.getTime() + 12 * 60 * 60 * 1000);

    // 3. ПАРАЛЛЕЛЬНОЕ ВЫПОЛНЕНИЕ ВСЕХ СЕТЕВЫХ ЗАПРОСОВ
    // Мы инициируем все запросы одновременно и ждем их завершения.
    // Это сокращает общее время ожидания с суммы времен всех запросов до времени самого долгого из них.
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
    // Мы также можем распараллелить запись в БД для дополнительной экономии времени.
    await Promise.all([
        saveTemperatureData(currentHour, { actual: actualTemp }),
        saveTemperatureData(forecastTargetTime, {
            yandex_forecast: yandexForecast,
            meteo_forecast: meteoForecast
        })
    ]);

    // 6. Отправка успешного ответа
    const responsePayload = {
      success: true,
      actual: actualTemp,
      yandex_forecast: yandexForecast,
      meteo_forecast: meteoForecast,
      target_time: forecastTargetTime.toISOString(),
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache', // Важно, чтобы cron-job всегда вызывал функцию
       },
    });

  } catch (error) {
    console.error('Общая ошибка в API-маршруте collect:', error);
    return new Response(JSON.stringify({ error: 'Внутренняя ошибка сервера' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
