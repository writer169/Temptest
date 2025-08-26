import { saveTemperatureData } from '../../lib/mongodb';

export default async function handler(req, res) {
  // Проверка UUID
  const { uuid } = req.query;
  if (!uuid || uuid !== process.env.UUID) {
    return res.status(403).json({ error: 'Недопустимый UUID' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не разрешен' });
  }

  try {
    const now = new Date();
    // Текущее время в UTC+5
    const currentTimeUTC5 = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    // Округляем к текущему часу (XX:00)
    const currentHour = new Date(currentTimeUTC5);
    currentHour.setMinutes(0, 0, 0);

    // Время для прогнозов (+12 часов)
    const forecastTargetTime = new Date(currentHour.getTime() + 12 * 60 * 60 * 1000);

    console.log('Current hour:', currentHour.toISOString());
    console.log('Forecast target time:', forecastTargetTime.toISOString());

    // Получаем реальную температуру из Narodmon
    let actualTemp = null;
    try {
      const narodmonResponse = await fetch(
        `https://narodmon.ru/api?cmd=sensorsValues&sensors=37687&uuid=${process.env.NARODMON_UUID}&api_key=${process.env.NARODMON_KEY}`
      );
      const narodmonData = await narodmonResponse.json();
      
      if (narodmonData.sensors && narodmonData.sensors[0] && narodmonData.sensors[0].value !== null) {
        actualTemp = Number(narodmonData.sensors[0].value);
      } else {
        throw new Error('Данные сенсора недоступны');
      }
    } catch (error) {
      console.error('Ошибка получения данных Narodmon:', error);
      return res.status(500).json({ error: 'Ошибка получения данных сенсора' });
    }

    // Сохраняем реальную температуру
    await saveTemperatureData(currentHour, { actual: actualTemp });

    // Получаем прогнозы
    let yandexForecast = null;
    let meteoForecast = null;

    // Yandex Weather
    try {
      const yandexResponse = await fetch(
        'https://api.weather.yandex.ru/v2/forecast?lat=43.23&lon=76.86',
        {
          headers: {
            'X-Yandex-Weather-Key': process.env.YANDEX_KEY
          }
        }
      );
      const yandexData = await yandexResponse.json();
      
      const targetDate = forecastTargetTime.toISOString().split('T')[0]; // YYYY-MM-DD
      const targetHour = forecastTargetTime.getHours();
      
      const forecast = yandexData.forecasts?.find(f => f.date === targetDate);
      if (forecast && forecast.hours) {
        const hourData = forecast.hours.find(h => parseInt(h.hour) === targetHour);
        if (hourData && hourData.temp !== undefined) {
          yandexForecast = Number(hourData.temp);
        }
      }
      
      console.log('Yandex forecast found:', yandexForecast);
    } catch (error) {
      console.error('Ошибка получения прогноза Yandex:', error);
    }

    // Open-Meteo
    try {
      const meteoResponse = await fetch(
        'https://api.open-meteo.com/v1/forecast?latitude=43.23&longitude=76.86&timezone=auto&hourly=temperature_2m&models=ecmwf_aifs025_single'
      );
      const meteoData = await meteoResponse.json();
      
      console.log('Open-Meteo response timezone:', meteoData.timezone);
      console.log('Open-Meteo first few times:', meteoData.hourly?.time?.slice(0, 5));
      
      // Создаем целевое время в формате Open-Meteo (без секунд)
      const targetTimeForMeteo = forecastTargetTime.toISOString().substring(0, 13) + ':00'; // YYYY-MM-DDTHH:00
      console.log('Looking for time:', targetTimeForMeteo);
      
      const timeIndex = meteoData.hourly?.time?.findIndex(time => time === targetTimeForMeteo);
      console.log('Found time index:', timeIndex);
      
      if (timeIndex !== -1 && meteoData.hourly?.temperature_2m?.[timeIndex] !== undefined) {
        meteoForecast = Number(meteoData.hourly.temperature_2m[timeIndex]);
        console.log('Meteo forecast found:', meteoForecast);
      } else {
        console.log('Meteo forecast not found. Available times around target:');
        if (meteoData.hourly?.time) {
          const targetIndex = meteoData.hourly.time.findIndex(t => t >= targetTimeForMeteo);
          const startIdx = Math.max(0, targetIndex - 2);
          const endIdx = Math.min(meteoData.hourly.time.length, targetIndex + 3);
          console.log(meteoData.hourly.time.slice(startIdx, endIdx));
        }
      }
    } catch (error) {
      console.error('Ошибка получения прогноза Open-Meteo:', error);
    }

    // Сохраняем прогнозы
    if (yandexForecast !== null || meteoForecast !== null) {
      await saveTemperatureData(forecastTargetTime, {
        yandex_forecast: yandexForecast,
        meteo_forecast: meteoForecast
      });
    }

    res.status(200).json({ 
      success: true, 
      actual: actualTemp,
      yandex_forecast: yandexForecast,
      meteo_forecast: meteoForecast,
      target_time: forecastTargetTime.toISOString(),
      debug: {
        current_hour: currentHour.toISOString(),
        forecast_target: forecastTargetTime.toISOString(),
        target_time_for_meteo: forecastTargetTime.toISOString().substring(0, 13) + ':00'
      }
    });

  } catch (error) {
    console.error('Ошибка в webhook:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}