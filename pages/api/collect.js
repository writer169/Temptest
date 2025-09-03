import { saveTemperatureData } from '../../lib/mongodb';

function getLocalTimeStringForMeteo(dateUTC) {
  const options = {
    timeZone: 'Asia/Almaty',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  };
  const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(dateUTC);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  return `${year}-${month}-${day}T${hour}:00`;
}

export default async function handler(req, res) {
  // 1. Проверки безопасности
  const { uuid } = req.query;
  if (!uuid || uuid !== process.env.UUID) {
    return res.status(403).json({ error: 'Недопустимый UUID' });
  }
  if (req.method !== 'POST') {
     return res.status(405).json({ error: 'Метод не разрешен' });
  }

  try {
    // 2. Вычисление времени в UTC
    const now = new Date();
    const currentHourUTC = new Date(now);
    currentHourUTC.setMinutes(0, 0, 0);
    const forecastTargetTimeUTC = new Date(currentHourUTC.getTime() + 12 * 60 * 60 * 1000);

    // 3. Сетевые запросы
    const [narodmonResult, yandexResult, meteoResult] = await Promise.allSettled([
      fetch(`https://narodmon.ru/api?cmd=sensorsValues&sensors=37687&uuid=${process.env.NARODMON_UUID}&api_key=${process.env.NARODMON_KEY}`).then(r => r.json()),
      fetch('https://api.weather.yandex.ru/v2/forecast?lat=43.23&lon=76.86', { headers: { 'X-Yandex-Weather-Key': process.env.YANDEX_KEY } }).then(r => r.json()),
      fetch('https://api.open-meteo.com/v1/forecast?latitude=43.23&longitude=76.86&timezone=auto&hourly=temperature_2m&models=ecmwf_aifs025_single').then(r => r.json())
    ]);

    // 4. Обработка результатов
    if (narodmonResult.status === 'rejected' || !narodmonResult.value.sensors?.[0]?.value) {
      throw new Error('Критическая ошибка: не удалось получить данные с сенсора Narodmon.');
    }
    const actualTemp = Number(narodmonResult.value.sensors[0].value);
    
    // Yandex Weather - исправленная версия
    let yandexForecast = null;
    if (yandexResult.status === 'fulfilled') {
      const yandexData = yandexResult.value;
      
      // Получаем нашу целевую метку времени в секундах (как в API Яндекса)
      const targetTimestamp = Math.floor(forecastTargetTimeUTC.getTime() / 1000);
      
      // Ищем во ВСЕХ доступных прогнозах (обычно forecasts[0] и forecasts[1])
      let hourData = null;
      
      if (yandexData.forecasts && Array.isArray(yandexData.forecasts)) {
        for (const forecast of yandexData.forecasts) {
          if (forecast?.hours && Array.isArray(forecast.hours)) {
            // Ищем в массиве часов объект с точно таким же timestamp
            hourData = forecast.hours.find(h => h.hour_ts === targetTimestamp);
            if (hourData) {
              break; // Нашли нужные данные, выходим из цикла
            }
          }
        }
      }

      if (hourData?.temp !== undefined) {
        yandexForecast = Number(hourData.temp);
      }
    } else {
      console.error('Ошибка получения прогноза Yandex:', yandexResult.reason);
    }
    
    // Open-Meteo
    let meteoForecast = null;
    if (meteoResult.status === 'fulfilled') {
      const meteoData = meteoResult.value;
      const targetTimeForMeteo = getLocalTimeStringForMeteo(forecastTargetTimeUTC);
      const timeIndex = meteoData.hourly?.time?.findIndex(time => time === targetTimeForMeteo);
      if (timeIndex > -1 && meteoData.hourly?.temperature_2m?.[timeIndex] !== undefined) {
        meteoForecast = Number(meteoData.hourly.temperature_2m[timeIndex]);
      }
    } else {
      console.error('Ошибка получения прогноза Open-Meteo:', meteoResult.reason);
    }

    // 5. Запись в базу данных в UTC
    await Promise.all([
        saveTemperatureData(currentHourUTC, { actual: actualTemp }),
        saveTemperatureData(forecastTargetTimeUTC, {
            yandex_forecast: yandexForecast ?? null,
            meteo_forecast: meteoForecast ?? null
        })
    ]);

    // 6. Отправка ответа
    return res.status(200).json({
      success: true,
      actual: actualTemp,
      yandex_forecast: yandexForecast ?? null,
      meteo_forecast: meteoForecast ?? null,
      target_time: forecastTargetTimeUTC.toISOString(),
    });

  } catch (error) {
    console.error('Общая ошибка в API-маршруте collect:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}