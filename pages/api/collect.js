import { saveTemperatureData, connectToDatabase } from '../../lib/mongodb';

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

// Функция для получения данных с Tuya датчика
async function getTuyaTemperature() {
  const deviceId = process.env.TUYA_DEVICE_ID;
  const token = process.env.TUYA_API_TOKEN;
  
  const response = await fetch(
    `https://secure-apitask.vercel.app/api/tuya?action=request&path=/v1.0/devices/${deviceId}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );
  
  if (!response.ok) {
    throw new Error(`Tuya API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  if (!data.success || !data.result?.result) {
    throw new Error('Неверный формат ответа от Tuya API');
  }
  
  const device = data.result.result;
  
  // Получаем температуру из статуса
  const tempStatus = device.status?.find(s => s.code === 'va_temperature');
  if (!tempStatus || tempStatus.value === undefined) {
    throw new Error('Температура не найдена в данных датчика');
  }
  
  // Конвертируем температуру (177 -> 17.7)
  const temperature = tempStatus.value / 10;
  
  return {
    temperature,
    online: device.online
  };
}

// Функция для получения последних N показаний температуры
async function getLastNReadings(count) {
  const client = await connectToDatabase();
  const db = client.db('weather');
  const collection = db.collection('temperature_readings');
  
  const readings = await collection.find({
    actual: { $ne: null }
  })
  .sort({ target_time: -1 })
  .limit(count)
  .toArray();
  
  return readings;
}

// Функция для проверки, завис ли датчик (температура равна последним двум значениям)
async function isSensorStuck(currentTemp) {
  const lastTwo = await getLastNReadings(2);
  
  // Если нет двух предыдущих значений, считаем что датчик не завис
  if (lastTwo.length < 2) {
    return false;
  }
  
  // Проверяем, равна ли текущая температура обоим предыдущим значениям
  const allEqual = lastTwo.every(reading => reading.actual === currentTemp);
  
  if (allEqual) {
    console.log(`Датчик завис: температура ${currentTemp}°C повторяется 3 раза подряд`);
    return true;
  }
  
  return false;
}

// Функция для удаления последовательных одинаковых значений (когда датчик offline)
async function cleanupDuplicateReadings() {
  const client = await connectToDatabase();
  const db = client.db('weather');
  const collection = db.collection('temperature_readings');
  
  // Получаем последние 12 показаний
  const last12 = await collection.find({
    actual: { $ne: null }
  })
  .sort({ target_time: -1 })
  .limit(12)
  .toArray();
  
  if (last12.length < 2) {
    console.log('Недостаточно данных для очистки');
    return { deletedCount: 0 };
  }
  
  // Сортируем в хронологическом порядке (от старых к новым)
  last12.reverse();
  
  // Находим последовательности одинаковых значений
  const toDelete = [];
  let sequenceStart = 0;
  
  for (let i = 1; i < last12.length; i++) {
    const currentValue = last12[i].actual;
    const previousValue = last12[i - 1].actual;
    
    if (currentValue !== previousValue) {
      // Последовательность закончилась
      // Если было 2+ одинаковых значения подряд, удаляем все кроме первого
      if (i - sequenceStart >= 2) {
        for (let j = sequenceStart + 1; j < i; j++) {
          toDelete.push(last12[j]._id);
        }
      }
      sequenceStart = i;
    }
  }
  
  // Проверяем последнюю последовательность
  if (last12.length - sequenceStart >= 2) {
    for (let j = sequenceStart + 1; j < last12.length; j++) {
      toDelete.push(last12[j]._id);
    }
  }
  
  // Удаляем найденные дубликаты
  if (toDelete.length > 0) {
    const result = await collection.deleteMany({
      _id: { $in: toDelete }
    });
    console.log(`Удалено ${result.deletedCount} дублирующихся показаний при offline датчике`);
    return result;
  }
  
  console.log('Дублирующихся показаний не найдено');
  return { deletedCount: 0 };
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

    // 3. Получаем данные с Tuya датчика
    let tuyaData;
    try {
      tuyaData = await getTuyaTemperature();
    } catch (error) {
      console.error('Ошибка получения данных Tuya:', error);
      throw new Error('Критическая ошибка: не удалось получить данные с датчика Tuya.');
    }

    console.log(`Tuya датчик: ${tuyaData.temperature}°C, online: ${tuyaData.online}`);

    // 4. Если датчик не в сети - очищаем дубликаты из последних 12 значений
    if (!tuyaData.online) {
      console.log('Датчик не в сети, запускаем очистку дубликатов...');
      await cleanupDuplicateReadings();
      throw new Error('Датчик не в сети');
    }

    // 5. Проверяем, не завис ли датчик (температура равна последним двум)
    const sensorStuck = await isSensorStuck(tuyaData.temperature);
    
    let actualTempToSave = null;
    if (sensorStuck) {
      console.log(`Пропускаем запись температуры ${tuyaData.temperature}°C - датчик завис`);
      // Не записываем температуру, но продолжаем работать с прогнозами
    } else {
      actualTempToSave = tuyaData.temperature;
    }

    // 6. Получаем прогнозы погоды
    const [yandexResult, meteoResult] = await Promise.allSettled([
      fetch('https://api.weather.yandex.ru/v2/forecast?lat=43.23&lon=76.86', { 
        headers: { 'X-Yandex-Weather-Key': process.env.YANDEX_KEY } 
      }).then(r => r.json()),
      fetch('https://api.open-meteo.com/v1/forecast?latitude=43.23&longitude=76.86&timezone=auto&hourly=temperature_2m&models=ecmwf_aifs025_single')
        .then(r => r.json())
    ]);
    
    // 7. Yandex Weather
    let yandexForecast = null;
    if (yandexResult.status === 'fulfilled') {
      const yandexData = yandexResult.value;
      const targetTimestamp = Math.floor(forecastTargetTimeUTC.getTime() / 1000);
      let hourData = null;
      
      if (yandexData.forecasts && Array.isArray(yandexData.forecasts)) {
        for (const forecast of yandexData.forecasts) {
          if (forecast?.hours && Array.isArray(forecast.hours)) {
            hourData = forecast.hours.find(h => h.hour_ts === targetTimestamp);
            if (hourData) break;
          }
        }
      }

      if (hourData?.temp !== undefined) {
        yandexForecast = Number(hourData.temp);
      }
    } else {
      console.error('Ошибка получения прогноза Yandex:', yandexResult.reason);
    }
    
    // 8. Open-Meteo
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

    // 9. Запись в базу данных в UTC
    const savePromises = [];
    
    // Сохраняем актуальную температуру только если датчик не завис
    if (actualTempToSave !== null) {
      savePromises.push(
        saveTemperatureData(currentHourUTC, { actual: actualTempToSave })
      );
    }
    
    // Прогнозы сохраняем всегда
    savePromises.push(
      saveTemperatureData(forecastTargetTimeUTC, {
        yandex_forecast: yandexForecast ?? null,
        meteo_forecast: meteoForecast ?? null
      })
    );
    
    await Promise.all(savePromises);

    // 10. Отправка ответа
    return res.status(200).json({
      success: true,
      actual: actualTempToSave,
      sensor_stuck: sensorStuck,
      yandex_forecast: yandexForecast ?? null,
      meteo_forecast: meteoForecast ?? null,
      target_time: forecastTargetTimeUTC.toISOString(),
      tuya_online: tuyaData.online
    });

  } catch (error) {
    console.error('Общая ошибка в API-маршруте collect:', error);
    return res.status(500).json({ 
      error: 'Внутренняя ошибка сервера', 
      details: error.message 
    });
  }
}