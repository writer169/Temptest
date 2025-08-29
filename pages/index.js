import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import { getTemperatureData, getCurrentHourData, getAccuracyData } from '../lib/mongodb';

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false });

export async function getServerSideProps({ query }) {
  const { uuid } = query;
  
  // Проверка UUID
  if (!uuid || uuid !== process.env.UUID) {
    return {
      notFound: true
    };
  }

  try {
    const [chartData, currentData, accuracyData] = await Promise.all([
      getTemperatureData(24),
      getCurrentHourData(),
      getAccuracyData(30)
    ]);

    return {
      props: {
        chartData: JSON.parse(JSON.stringify(chartData)),
        currentData: JSON.parse(JSON.stringify(currentData)),
        accuracyData: JSON.parse(JSON.stringify(accuracyData))
      }
    };
  } catch (error) {
    console.error('Ошибка получения данных:', error);
    return {
      props: {
        chartData: [],
        currentData: null,
        accuracyData: []
      }
    };
  }
}

// Функция для проверки валидности значения (null, undefined, NaN)
function isValidValue(value) {
  return value !== null && value !== undefined && !isNaN(value) && isFinite(value);
}

function interpolateData(data, field) {
  const result = [...data];
  
  for (let i = 1; i < result.length - 1; i++) {
    if (!isValidValue(result[i][field])) {
      // Найти предыдущую и следующую валидные точки
      let prevIndex = i - 1;
      let nextIndex = i + 1;
      
      while (prevIndex >= 0 && !isValidValue(result[prevIndex][field])) {
        prevIndex--;
      }
      while (nextIndex < result.length && !isValidValue(result[nextIndex][field])) {
        nextIndex++;
      }
      
      if (prevIndex >= 0 && nextIndex < result.length) {
        // Линейная интерполяция
        const prevValue = result[prevIndex][field];
        const nextValue = result[nextIndex][field];
        const ratio = (i - prevIndex) / (nextIndex - prevIndex);
        result[i][field] = prevValue + (nextValue - prevValue) * ratio;
      }
    }
  }
  
  return result;
}

function calculateMAE(data, forecastField) {
  const validData = data.filter(d => isValidValue(d.actual) && isValidValue(d[forecastField]));
  if (validData.length === 0) return null;
  
  const errors = validData.map(d => Math.abs(d[forecastField] - d.actual));
  return errors.reduce((sum, error) => sum + error, 0) / errors.length;
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];
  
  // Конвертируем в часовой пояс Алматы
  const almatyDate = new Date(date.toLocaleString("en-US", {timeZone: "Asia/Almaty"}));
  
  return `${almatyDate.getDate()} ${months[almatyDate.getMonth()]} ${almatyDate.getHours()}:00`;
}

export default function Home({ chartData, currentData, accuracyData }) {
  const router = useRouter();
  const [plotData, setPlotData] = useState([]);
  const [layout, setLayout] = useState({});

  useEffect(() => {
    if (chartData.length === 0) {
      setPlotData([]);
      setLayout({
        title: 'Данные собираются...',
        xaxis: { title: 'Время' },
        yaxis: { title: 'Температура °C' },
        showlegend: true,
        responsive: true
      });
      return;
    }

    // Интерполируем данные для графиков
    const interpolatedData = interpolateData(chartData, 'actual');
    const yandexInterpolated = interpolateData(chartData, 'yandex_forecast');
    const meteoInterpolated = interpolateData(chartData, 'meteo_forecast');

    const times = chartData.map(d => new Date(d.target_time).toLocaleTimeString('ru-RU', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: 'Asia/Almaty'
    }));

    const traces = [
      {
        x: times,
        y: interpolatedData.map(d => d.actual),
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Эталон',
        line: { color: 'blue' }
      }
    ];

    // Добавляем прогнозы только если есть данные (после 12 часов)
    const hasYandexData = yandexInterpolated.some(d => isValidValue(d.yandex_forecast));
    const hasMeteoData = meteoInterpolated.some(d => isValidValue(d.meteo_forecast));

    if (hasYandexData) {
      traces.push({
        x: times,
        y: yandexInterpolated.map(d => d.yandex_forecast),
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Yandex',
        line: { color: 'red' }
      });
    }

    if (hasMeteoData) {
      traces.push({
        x: times,
        y: meteoInterpolated.map(d => d.meteo_forecast),
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Open-Meteo',
        line: { color: 'green' }
      });
    }

    setPlotData(traces);
    setLayout({
      title: 'Температура за последние 24 часа',
      xaxis: { 
        title: 'Время',
        tickformat: '%H:%M'
      },
      yaxis: { title: 'Температура °C' },
      showlegend: true,
      responsive: true,
      hovermode: 'x unified'
    });
  }, [chartData]);

  const yandexMAE = calculateMAE(accuracyData, 'yandex_forecast');
  const meteoMAE = calculateMAE(accuracyData, 'meteo_forecast');

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>Мониторинг точности прогнозов температуры</h1>
      
      <div style={{ marginBottom: '30px' }}>
        <Plot
          data={plotData}
          layout={{
            ...layout,
            autosize: true,
            margin: { t: 50, r: 50, b: 50, l: 50 }
          }}
          style={{ width: '100%', height: '500px' }}
          useResizeHandler={true}
          config={{ responsive: true, displayModeBar: true }}
        />
      </div>

      {currentData && (
        <div style={{ 
          backgroundColor: '#f5f5f5', 
          padding: '20px', 
          borderRadius: '8px',
          marginBottom: '20px'
        }}>
          <h3>{formatDate(currentData.target_time)}</h3>
          <p><strong>Эталон:</strong> {isValidValue(currentData.actual) ? `${currentData.actual}°C` : 'N/A'}</p>
          
          <p>
            <strong>Open-Meteo:</strong> {isValidValue(currentData.meteo_forecast) ? `${currentData.meteo_forecast}°C` : 'N/A'}
            {isValidValue(currentData.meteo_forecast) && isValidValue(currentData.actual) && (
              <> | <strong>Ошибка:</strong> {Math.abs(currentData.meteo_forecast - currentData.actual).toFixed(1)}°C</>
            )}
          </p>
          
          <p>
            <strong>Yandex:</strong> {isValidValue(currentData.yandex_forecast) ? `${currentData.yandex_forecast}°C` : 'N/A'}
            {isValidValue(currentData.yandex_forecast) && isValidValue(currentData.actual) && (
              <> | <strong>Ошибка:</strong> {Math.abs(currentData.yandex_forecast - currentData.actual).toFixed(1)}°C</>
            )}
          </p>
        </div>
      )}

      <div style={{ 
        backgroundColor: '#e8f4f8', 
        padding: '20px', 
        borderRadius: '8px'
      }}>
        <h3>Анализ точности за 30 дней</h3>
        <p>
          <strong>Точность Open-Meteo:</strong> {
            meteoMAE !== null ? `${meteoMAE.toFixed(2)}°C (MAE)` : 'Недостаточно данных'
          }
        </p>
        <p>
          <strong>Точность Yandex:</strong> {
            yandexMAE !== null ? `${yandexMAE.toFixed(2)}°C (MAE)` : 'Недостаточно данных'
          }
        </p>
      </div>
    </div>
  );
}