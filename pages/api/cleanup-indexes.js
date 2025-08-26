import { connectToDatabase } from '../../lib/mongodb';

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
    const client = await connectToDatabase();
    const db = client.db('weather');
    const collection = db.collection('temperature_readings');

    // Получаем список всех индексов
    const indexes = await collection.listIndexes().toArray();
    console.log('Существующие индексы:', indexes.map(i => ({ name: i.name, key: i.key })));

    // Удаляем все индексы кроме _id
    for (const index of indexes) {
      if (index.name !== '_id_') {
        try {
          await collection.dropIndex(index.name);
          console.log(`Удален индекс: ${index.name}`);
        } catch (error) {
          console.error(`Ошибка удаления индекса ${index.name}:`, error.message);
        }
      }
    }

    // Создаем новый правильный индекс
    await collection.createIndex(
      { target_time: 1 }, 
      { 
        name: 'target_time_ttl',
        expireAfterSeconds: 30 * 24 * 3600 // 30 дней
      }
    );

    console.log('Создан новый индекс с TTL');

    // Проверяем результат
    const newIndexes = await collection.listIndexes().toArray();
    
    res.status(200).json({ 
      success: true, 
      message: 'Индексы очищены и пересозданы',
      indexes: newIndexes.map(i => ({ name: i.name, key: i.key, expireAfterSeconds: i.expireAfterSeconds }))
    });

  } catch (error) {
    console.error('Ошибка при очистке индексов:', error);
    res.status(500).json({ 
      error: 'Внутренняя ошибка сервера',
      details: error.message 
    });
  }
}