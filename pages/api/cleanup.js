import { connectToDatabase } from '../../lib/mongodb';

export default async function handler(req, res) {
  const { uuid, before } = req.query;

  // Проверка UUID
  if (!uuid || uuid !== process.env.UUID) {
    return res.status(403).json({ error: 'Недопустимый UUID' });
  }

  // Разрешаем только DELETE-запрос
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Метод не разрешён' });
  }

  try {
    const client = await connectToDatabase();
    const db = client.db('weather');
    const collection = db.collection('temperature_readings');

    // Если не указана дата, удаляем все записи
    let filter = {};
    if (before) {
      const cutoff = new Date(before);
      if (isNaN(cutoff)) {
        return res.status(400).json({ error: 'Неверный формат даты. Используй YYYY-MM-DD или ISO.' });
      }
      filter = { target_time: { $lt: cutoff } };
    }

    const result = await collection.deleteMany(filter);

    res.status(200).json({
      success: true,
      deletedCount: result.deletedCount,
      message: before
        ? `Удалены записи до ${before}`
        : `Удалены все записи из коллекции`
    });
  } catch (error) {
    console.error('Ошибка очистки базы:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}