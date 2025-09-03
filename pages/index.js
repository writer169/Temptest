import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import { getTemperatureData, getCurrentHourData, getAccuracyData } from '../lib/mongodb';

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false });

export async function getServerSideProps({ query }) {
  const { uuid } = query;
  if (!uuid || uuid !== process.env.UUID) {
    return { notFound: true };
  }

  try {
    const [chartData, currentData, accuracyData] = await Promise.all([
      getTemperatureData(24),
      getCurrentHourData(),
      getAccuracyData(30),
    ]);

    return {
      props: {
        chartData: JSON.parse(JSON.stringify(chartData)),
        currentData: JSON.parse(JSON.stringify(currentData)),
        accuracyData: JSON.parse(JSON.stringify(accuracyData)),
      },
    };
  } catch (error) {
    console.error('Ошибка получения данных:', error);
    return {
      props: {
        chartData: [],
        currentData: null,
        accuracyData: [],
      },
    };
  }
}

function isValidValue(value) {
  return value !== null && value !== undefined && !isNaN(value) && isFinite(value);
}

function interpolateData(data, field) {
  const result = [...data];
  for (let i = 1; i < result.length - 1; i++) {
    if (!isValidValue(result[i][field])) {
      let prevIndex = i - 1;
      let nextIndex = i + 1;
      while (prevIndex >= 0 && !isValidValue(result[prevIndex][field])) {
        prevIndex--;
      }
      while (nextIndex < result.length && !isValidValue(result[nextIndex][field])) {
        nextIndex++;
      }
      if (prevIndex >= 0 && nextIndex < result.length) {
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
  const almatyDate = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Almaty" }));
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
        xaxis: { tickformat: '%H' },
        yaxis: { dtick: 2 },
        showlegend: true,
        legend: { y: -0.2, yanchor: 'top', orientation: 'h' },
        responsive: true,
        hovermode: 'x unified',
      });
      return;
    }

    // Сортируем данные по времени
    const sortedData = [...chartData].sort((a, b) => 
      new Date(a.target_time).getTime() - new Date(b.target_time).getTime()
    );

    const interpolatedData = interpolateData(sortedData, 'actual');
    const yandexInterpolated = interpolateData(sortedData, 'yandex_forecast');
    const meteoInterpolated = interpolateData(sortedData, 'meteo_forecast');

    // Используем полные объекты Date для корректной сортировки
    const times = sortedData.map(d => new Date(d.target_time));

    const traces = [
      {
        x: times,
        y: interpolatedData.map(d => d.actual),
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Эталон',
        line: { color: '#EF4444' },
        marker: { size: 6 },
      },
    ];

    const hasYandexData = yandexInterpolated.some(d => isValidValue(d.yandex_forecast));
    const hasMeteoData = meteoInterpolated.some(d => isValidValue(d.meteo_forecast));

    if (hasYandexData) {
      traces.push({
        x: times,
        y: yandexInterpolated.map(d => d.yandex_forecast),
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Yandex',
        line: { color: '#3B82F6' },
        marker: { size: 6 },
      });
    }

    if (hasMeteoData) {
      traces.push({
        x: times,
        y: meteoInterpolated.map(d => d.meteo_forecast),
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Open-Meteo',
        line: { color: '#10B981' },
        marker: { size: 6 },
      });
    }

    setPlotData(traces);
    setLayout({
      xaxis: { 
        type: 'date',
        tickformat: '%H',
        dtick: 3600000, // Тики каждый час
      },
      yaxis: { 
        dtick: 2 // Шаг 2 градуса для температуры
      },
      showlegend: true,
      legend: {
        y: -0.2,
        yanchor: 'top',
        orientation: 'h',
        xanchor: 'center',
        x: 0.5,
      },
      responsive: true,
      hovermode: 'x unified',
      margin: { t: 20, r: 20, b: 100, l: 40 },
    });
  }, [chartData]);

  const yandexMAE = calculateMAE(accuracyData, 'yandex_forecast');
  const meteoMAE = calculateMAE(accuracyData, 'meteo_forecast');

  return (
    <div className="min-h-screen bg-gray-50 p-4 font-sans">
      {/* Graph Section */}
      <div className="mb-6 rounded-lg bg-white shadow-sm">
        <Plot
          data={plotData}
          layout={{
            ...layout,
            autosize: true,
          }}
          style={{ width: '100%', height: '400px' }}
          useResizeHandler={true}
          config={{
            responsive: true,
            displayModeBar: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['toImage', 'lasso2d', 'select2d'],
          }}
        />
      </div>

      {/* Combined Data Card */}
      {(currentData || yandexMAE !== null || meteoMAE !== null) && (
        <div className="rounded-lg bg-white p-6 shadow-sm transition-all duration-200 hover:shadow-md">
          {currentData && (
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-gray-800">
                {formatDate(currentData.target_time)}
              </h3>
              <div className="mt-2 space-y-2">
                <p className="text-sm text-gray-600">
                  <span className="font-medium">Эталон:</span>{' '}
                  {isValidValue(currentData.actual) ? `${currentData.actual}°C` : 'N/A'}
                </p>
                <p className="text-sm text-gray-600">
                  <span className="font-medium">Open-Meteo:</span>{' '}
                  {isValidValue(currentData.meteo_forecast)
                    ? `${currentData.meteo_forecast}°C`
                    : 'N/A'}
                  {isValidValue(currentData.meteo_forecast) &&
                    isValidValue(currentData.actual) && (
                      <span className="ml-2">
                        | <span className="font-medium">Ошибка:</span>{' '}
                        {Math.abs(currentData.meteo_forecast - currentData.actual).toFixed(1)}°C
                      </span>
                    )}
                </p>
                <p className="text-sm text-gray-600">
                  <span className="font-medium">Yandex:</span>{' '}
                  {isValidValue(currentData.yandex_forecast)
                    ? `${currentData.yandex_forecast}°C`
                    : 'N/A'}
                  {isValidValue(currentData.yandex_forecast) &&
                    isValidValue(currentData.actual) && (
                      <span className="ml-2">
                        | <span className="font-medium">Ошибка:</span>{' '}
                        {Math.abs(currentData.yandex_forecast - currentData.actual).toFixed(1)}°C
                      </span>
                    )}
                </p>
              </div>
            </div>
          )}
          <div>
            <h3 className="text-lg font-semibold text-gray-800">Точность за 30 дней</h3>
            <div className="mt-2 space-y-2">
              <p className="text-sm text-gray-600">
                <span className="font-medium">Open-Meteo:</span>{' '}
                {meteoMAE !== null ? `${meteoMAE.toFixed(2)}°C (MAE)` : 'Недостаточно данных'}
              </p>
              <p className="text-sm text-gray-600">
                <span className="font-medium">Yandex:</span>{' '}
                {yandexMAE !== null ? `${yandexMAE.toFixed(2)}°C (MAE)` : 'Недостаточно данных'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}