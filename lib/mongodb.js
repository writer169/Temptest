import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);

let cachedClient = null;

export async function connectToDatabase() {
  if (cachedClient) {
    return cachedClient;
  }

  try {
    await client.connect();
    cachedClient = client;
    
    // Создаем индексы при первом подключении
    const db = client.db('weather');
    const collection = db.collection('temperature_readings');
    
    // Проверяем существующие индексы
    const existingIndexes = await collection.listIndexes().toArray();
    const hasTimeIndex = existingIndexes.some(index => 
      index.name === 'target_time_1' || 
      (index.key && index.key.target_time === 1)
    );
    
    if (!hasTimeIndex) {
      // Создаем единый индекс с TTL
      await collection.createIndex(
        { target_time: 1 }, 
        { 
          name: 'target_time_ttl',
          expireAfterSeconds: 30 * 24 * 3600 // 30 дней
        }
      );
      console.log('Создан индекс с TTL для target_time');
    } else {
      console.log('Индекс target_time уже существует');
    }
    
    return cachedClient;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

export async function getTemperatureData(hours = 24) {
  const client = await connectToDatabase();
  const db = client.db('weather');
  const collection = db.collection('temperature_readings');

  const now = new Date();
  // Округляем к текущему часу в UTC+5
  const currentHour = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  currentHour.setMinutes(0, 0, 0);
  
  const startTime = new Date(currentHour.getTime() - hours * 60 * 60 * 1000);

  const data = await collection.find({
    target_time: {
      $gte: startTime,
      $lte: currentHour
    }
  }).sort({ target_time: 1 }).toArray();

  return data;
}

export async function saveTemperatureData(targetTime, data) {
  const client = await connectToDatabase();
  const db = client.db('weather');
  const collection = db.collection('temperature_readings');

  return await collection.updateOne(
    { target_time: targetTime },
    { $set: data },
    { upsert: true }
  );
}

export async function getCurrentHourData() {
  const client = await connectToDatabase();
  const db = client.db('weather');
  const collection = db.collection('temperature_readings');

  const now = new Date();
  // Округляем к текущему часу в UTC+5
  const currentHour = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  currentHour.setMinutes(0, 0, 0);

  return await collection.findOne({ target_time: currentHour });
}

export async function getAccuracyData(days = 30) {
  const client = await connectToDatabase();
  const db = client.db('weather');
  const collection = db.collection('temperature_readings');

  const now = new Date();
  const startTime = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const data = await collection.find({
    target_time: { $gte: startTime },
    actual: { $ne: null }
  }).toArray();

  return data;
}