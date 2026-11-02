
import { Platform } from 'react-native';
import MapView, {
  Marker,
  PROVIDER_DEFAULT,
  UrlTile,
} from 'react-native-maps';

const API_KEY = process.env.EXPO_PUBLIC_CARTO_API_KEY;

const requestedStyle =
  process.env.EXPO_PUBLIC_CARTO_STYLE || 'voyager';

const allowedStyles = [
  'voyager',
  'voyager_nolabels',
  'voyager_only_labels',
  'voyager_labels_under',
];

const CARTO_STYLE = allowedStyles.includes(requestedStyle)
  ? requestedStyle
  : 'voyager';

export function CartoTileLayer() {
  if (Platform.OS !== 'android') return null;

  if (!API_KEY) {
    console.error('EXPO_PUBLIC_CARTO_API_KEY is not configured.');
    return null;
  }

  return (
    <UrlTile
      urlTemplate={`https://basemaps.cartocdn.com/rastertiles/${CARTO_STYLE}/{z}/{x}/{y}.png?key=${encodeURIComponent(API_KEY)}`}
      tileSize={256}
      minimumZ={0}
      maximumZ={20}
    />
  );
}

export { Marker, PROVIDER_DEFAULT };
export default MapView;
