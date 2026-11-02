
import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  useEffect,
} from 'react';
import { View, StyleSheet } from 'react-native';

export const CartoTileLayer = () => null;

export const PROVIDER_DEFAULT = null;

interface Region {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

interface MapViewProps {
  style?: any;
  initialRegion?: Region;
  region?: Region;
  showsUserLocation?: boolean;
  showsMyLocationButton?: boolean;
  onPress?: (e: any) => void;
  children?: React.ReactNode;
  provider?: any;
  scrollEnabled?: boolean;
  zoomEnabled?: boolean;
  rotateEnabled?: boolean;
  pitchEnabled?: boolean;
  mapType?: any;
}

interface MarkerProps {
  coordinate: { latitude: number; longitude: number };
  title?: string;
  description?: string;
  pinColor?: string;
  children?: React.ReactNode;
  onPress?: () => void;
  identifier?: string;
}

export const Marker = (_props: MarkerProps) => {
  return null;
};

let leafletLoaded = false;
let leafletLoadPromise: Promise<void> | null = null;

function loadLeaflet(): Promise<void> {
  if (leafletLoaded) return Promise.resolve();
  if (leafletLoadPromise) return leafletLoadPromise;

  leafletLoadPromise = new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

    script.onload = () => {
      leafletLoaded = true;
      resolve();
    };

    script.onerror = () => {
      console.error('Failed to load Leaflet.');
      resolve();
    };

    document.head.appendChild(script);
  });

  return leafletLoadPromise;
}

function getMarkerColorFromChild(child: any): string {
  if (!child || !child.props) return '#36D6C5';
  if (child.props.pinColor) return child.props.pinColor;

  const children = child.props.children;
  if (!children) return '#36D6C5';

  const childArr = React.Children.toArray(children);
  if (childArr.length === 0) return '#36D6C5';

  const firstChild: any = childArr[0];

  if (firstChild?.props?.style) {
    const style = Array.isArray(firstChild.props.style)
      ? Object.assign({}, ...firstChild.props.style.filter(Boolean))
      : firstChild.props.style;

    if (style.backgroundColor) return style.backgroundColor;
  }

  return '#36D6C5';
}

function getMarkerIconName(
  child: any
): { name: string; color: string } | null {
  if (!child?.props?.children) return null;

  const findIcon = (node: any): { name: string; color: string } | null => {
    if (!node) return null;

    if (
      node.props?.name &&
      typeof node.props.name === 'string' &&
      node.props.size
    ) {
      return {
        name: node.props.name,
        color: node.props.color || '#fff',
      };
    }

    if (node.props?.children) {
      const kids = React.Children.toArray(node.props.children);

      for (const kid of kids) {
        const found = findIcon(kid);
        if (found) return found;
      }
    }

    return null;
  };

  const kids = React.Children.toArray(child.props.children);

  for (const kid of kids) {
    const found = findIcon(kid);
    if (found) return found;
  }

  return null;
}

const ICON_SVG_MAP: Record<string, string> = {
  car: '<path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/>',
  person: '<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>',
  flag: '<path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6h-5.6z"/>',
};

function buildMarkerHtml(
  bgColor: string,
  iconInfo: { name: string; color: string } | null,
  size: number = 28
): string {
  const svgPath = iconInfo ? ICON_SVG_MAP[iconInfo.name] : null;

  const innerContent = svgPath
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size * 0.55}" height="${size * 0.55}" fill="${iconInfo!.color}">${svgPath}</svg>`
    : '';

  return `<div style="
    width:${size}px;height:${size}px;border-radius:50%;
    background:${bgColor};
    border:2px solid rgba(255,255,255,0.9);
    box-shadow:0 2px 6px rgba(0,0,0,0.4);
    display:flex;align-items:center;justify-content:center;
  ">${innerContent}</div>`;
}

const WebMapView = forwardRef<any, MapViewProps>((props, ref) => {
  const {
    style,
    initialRegion,
    region,
    children,
    onPress,
    showsUserLocation,
  } = props;

  const containerIdRef = useRef(
    'leaflet-map-' + Math.random().toString(36).slice(2)
  );

  const mapInstanceRef = useRef<any>(null);
  const markersLayerRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);

  const [ready, setReady] = useState(false);

  const initialRegionRef = useRef(region || initialRegion);
  const onPressRef = useRef(onPress);

  onPressRef.current = onPress;

  const getZoomFromDelta = (delta: number) => {
    return Math.min(18, Math.max(2, Math.round(Math.log2(360 / delta))));
  };

  useImperativeHandle(ref, () => ({
    animateToRegion: (newRegion: Region, _duration?: number) => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.setView(
          [newRegion.latitude, newRegion.longitude],
          getZoomFromDelta(newRegion.latitudeDelta)
        );
      }
    },

    fitToCoordinates: () => {},

    getCamera: () => Promise.resolve(null),
  }));

  useEffect(() => {
    let cancelled = false;

    loadLeaflet().then(() => {
      if (cancelled) return;

      const L = (window as any).L;
      if (!L) return;

      const el = document.getElementById(containerIdRef.current);
      if (!el) return;

      const reg = initialRegionRef.current;

      const center: [number, number] = reg
        ? [reg.latitude, reg.longitude]
        : [37.7749, -122.4194];

      const zoom = reg ? getZoomFromDelta(reg.latitudeDelta) : 14;

      const map = L.map(el, {
        center,
        zoom,
        zoomControl: false,
        attributionControl: false,
      });

      // ==========================================
      // CARTO VOYAGER BASEMAP CONFIGURATION
      // ==========================================

      const cartoApiKey = process.env.EXPO_PUBLIC_CARTO_API_KEY;

      const requestedStyle =
        process.env.EXPO_PUBLIC_CARTO_STYLE || 'voyager';

      const allowedStyles = [
        'voyager',
        'voyager_nolabels',
        'voyager_only_labels',
        'voyager_labels_under',
      ];

      const cartoStyle = allowedStyles.includes(requestedStyle)
        ? requestedStyle
        : 'voyager';

      if (cartoApiKey) {
        const cartoTiles = L.tileLayer(
          `https://{s}.basemaps.cartocdn.com/rastertiles/${cartoStyle}/{z}/{x}/{y}.png?key=${encodeURIComponent(cartoApiKey)}`,
          {
            subdomains: 'abcd',
            minZoom: 0,
            maxZoom: 20,
          }
        );

        cartoTiles.on('tileerror', () => {
          console.error(
            'CARTO tile request failed. Check your API key, account access and network connection.'
          );
        });

        cartoTiles.addTo(map);
      } else {
        console.error(
          'CARTO API key is missing. Check EXPO_PUBLIC_CARTO_API_KEY in .env.'
        );
      }

      // ==========================================
      // MAP ATTRIBUTION
      // ==========================================

      L.control.attribution({
        position: 'bottomright',
        prefix: false,
      })
        .addAttribution(
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        )
        .addTo(map);

      markersLayerRef.current = L.layerGroup().addTo(map);

      // Map click handling
      map.on('click', (e: any) => {
        if (onPressRef.current) {
          onPressRef.current({
            nativeEvent: {
              coordinate: {
                latitude: e.latlng.lat,
                longitude: e.latlng.lng,
              },
            },
          });
        }
      });

      // User location marker
      if (showsUserLocation && reg) {
        const userIcon = L.divIcon({
          className: 'user-location-marker',
          html: '<div style="width:16px;height:16px;border-radius:50%;background:#4285F4;border:3px solid #fff;box-shadow:0 0 8px rgba(66,133,244,0.6);"></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });

        userMarkerRef.current = L.marker(center, {
          icon: userIcon,
          zIndexOffset: 1000,
        }).addTo(map);
      }

      mapInstanceRef.current = map;

      setReady(true);

      setTimeout(() => map.invalidateSize(), 200);
    });

    return () => {
      cancelled = true;

      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  // Update map region
  useEffect(() => {
    if (!mapInstanceRef.current || !region) return;

    mapInstanceRef.current.setView(
      [region.latitude, region.longitude],
      getZoomFromDelta(region.latitudeDelta)
    );

    if (userMarkerRef.current && showsUserLocation) {
      userMarkerRef.current.setLatLng([
        region.latitude,
        region.longitude,
      ]);
    }
  }, [region?.latitude, region?.longitude]);

  // Render map markers
  useEffect(() => {
    if (
      !ready ||
      !mapInstanceRef.current ||
      !markersLayerRef.current
    ) {
      return;
    }

    const L = (window as any).L;
    if (!L) return;

    markersLayerRef.current.clearLayers();

    React.Children.forEach(children, (child: any) => {
      if (!child || !child.props?.coordinate) return;

      const { coordinate, title } = child.props;

      const bgColor = getMarkerColorFromChild(child);
      const iconInfo = getMarkerIconName(child);

      const hasCustomChildren = child.props.children != null;
      const markerSize = hasCustomChildren ? 28 : 14;

      const html = hasCustomChildren
        ? buildMarkerHtml(bgColor, iconInfo, markerSize)
        : `<div style="width:${markerSize}px;height:${markerSize}px;border-radius:50%;background:${bgColor};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`;

      const markerIcon = L.divIcon({
        className: 'custom-marker',
        html,
        iconSize: [markerSize, markerSize],
        iconAnchor: [markerSize / 2, markerSize / 2],
      });

      const marker = L.marker(
        [coordinate.latitude, coordinate.longitude],
        { icon: markerIcon }
      );

      if (title) {
        marker.bindTooltip(title, {
          direction: 'top',
          offset: [0, -(markerSize / 2 + 4)],
        });
      }

      if (child.props.onPress) {
        marker.on('click', child.props.onPress);
      }

      marker.addTo(markersLayerRef.current);
    });
  }, [children, ready]);

  return (
    <View style={[webStyles.container, style]}>
      <div
        id={containerIdRef.current}
        style={{
          width: '100%',
          height: '100%',
          position: 'absolute',
          top: 0,
          left: 0,
          background: '#101D32',
        }}
      />
    </View>
  );
});

const webStyles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
});

export default WebMapView;
