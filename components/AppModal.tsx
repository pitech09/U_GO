import React, { useEffect, useRef } from 'react';
import {
  View, Text, Pressable, StyleSheet, Modal, Platform,
  Animated as RNAnimated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Colors from '@/constants/colors';

export interface ModalAction {
  label: string;
  icon?: string;
  iconColor?: string;
  onPress: () => void;
  destructive?: boolean;
}

interface AppModalProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  message?: string;
  actions: ModalAction[];
  type?: 'actionsheet' | 'alert' | 'confirm';
}

function AnimatedAlert({ visible, onClose, title, message, actions }: Omit<AppModalProps, 'type'>) {
  const opacity = useRef(new RNAnimated.Value(0)).current;
  const scale = useRef(new RNAnimated.Value(0.95)).current;

  useEffect(() => {
    if (visible) {
      RNAnimated.parallel([
        RNAnimated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        RNAnimated.timing(scale, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  const handleClose = (cb?: () => void) => {
    RNAnimated.parallel([
      RNAnimated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }),
      RNAnimated.timing(scale, { toValue: 0.95, duration: 150, useNativeDriver: true }),
    ]).start(() => {
      onClose();
      cb?.();
    });
  };

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={() => handleClose()}>
      <RNAnimated.View style={[styles.overlay, styles.overlayCenter, { opacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => handleClose()} />
        <RNAnimated.View style={[styles.alertCard, { transform: [{ scale }] }]}>
          {title ? <Text style={styles.alertTitle}>{title}</Text> : null}
          {message ? <Text style={styles.alertMessage}>{message}</Text> : null}
          <View style={styles.alertActions}>
            {actions.map((action, i) => (
              <Pressable
                key={i}
                style={({ pressed }) => [
                  styles.alertBtn,
                  action.destructive && styles.alertBtnDestructive,
                  !action.destructive && i === actions.length - 1 && styles.alertBtnPrimary,
                  pressed && styles.pressed,
                ]}
                onPress={() => handleClose(action.onPress)}
              >
                <Text style={[
                  styles.alertBtnText,
                  action.destructive && styles.alertBtnTextDestructive,
                  !action.destructive && i === actions.length - 1 && styles.alertBtnTextPrimary,
                ]}>
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </RNAnimated.View>
      </RNAnimated.View>
    </Modal>
  );
}

function AnimatedSheet({ visible, onClose, title, actions }: Omit<AppModalProps, 'type'>) {
  const overlayOpacity = useRef(new RNAnimated.Value(0)).current;
  const translateY = useRef(new RNAnimated.Value(300)).current;

  useEffect(() => {
    if (visible) {
      RNAnimated.parallel([
        RNAnimated.timing(overlayOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        RNAnimated.timing(translateY, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  const handleClose = (cb?: () => void) => {
    RNAnimated.parallel([
      RNAnimated.timing(overlayOpacity, { toValue: 0, duration: 150, useNativeDriver: true }),
      RNAnimated.timing(translateY, { toValue: 300, duration: 200, useNativeDriver: true }),
    ]).start(() => {
      onClose();
      cb?.();
    });
  };

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={() => handleClose()}>
      <RNAnimated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => handleClose()} />
        <RNAnimated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
          <View style={styles.handle} />
          {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
          <View style={styles.sheetActions}>
            {actions.map((action, i) => (
              <Pressable
                key={i}
                style={({ pressed }) => [
                  styles.sheetItem,
                  pressed && styles.sheetItemPressed,
                  i < actions.length - 1 && styles.sheetItemBorder,
                ]}
                onPress={() => handleClose(action.onPress)}
              >
                {action.icon ? (
                  <View style={[styles.sheetIconWrap, { backgroundColor: action.destructive ? 'rgba(255,59,48,0.1)' : 'rgba(54, 214, 197, 0.1)' }]}>
                    <Ionicons
                      name={action.icon as any}
                      size={20}
                      color={action.iconColor || (action.destructive ? Colors.error : Colors.primary)}
                    />
                  </View>
                ) : null}
                <Text style={[
                  styles.sheetItemText,
                  action.destructive && styles.sheetItemTextDestructive,
                ]}>
                  {action.label}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
              </Pressable>
            ))}
          </View>
          <Pressable style={({ pressed }) => [styles.cancelBtn, pressed && styles.pressed]} onPress={() => handleClose()}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </RNAnimated.View>
      </RNAnimated.View>
    </Modal>
  );
}

export default function AppModal(props: AppModalProps) {
  const { visible, type = 'actionsheet' } = props;
  if (!visible) return null;

  if (type === 'alert' || type === 'confirm') {
    return <AnimatedAlert {...props} />;
  }
  return <AnimatedSheet {...props} />;
}

export function useAppModal() {
  const [modalState, setModalState] = React.useState<{
    visible: boolean;
    title?: string;
    message?: string;
    actions: ModalAction[];
    type: 'actionsheet' | 'alert' | 'confirm';
  }>({ visible: false, actions: [], type: 'alert' });

  const showAlert = (title: string, message: string, actions?: ModalAction[]) => {
    setModalState({
      visible: true,
      title,
      message,
      actions: actions || [{ label: 'OK', onPress: () => {} }],
      type: 'alert',
    });
  };

  const showConfirm = (title: string, message: string, onConfirm: () => void, confirmLabel = 'Confirm', destructive = false) => {
    setModalState({
      visible: true,
      title,
      message,
      actions: [
        { label: 'Cancel', onPress: () => {} },
        { label: confirmLabel, onPress: onConfirm, destructive },
      ],
      type: 'confirm',
    });
  };

  const showActionSheet = (title: string, actions: ModalAction[]) => {
    setModalState({ visible: true, title, actions, type: 'actionsheet' });
  };

  const closeModal = () => setModalState(prev => ({ ...prev, visible: false }));

  const modalProps: AppModalProps = {
    visible: modalState.visible,
    onClose: closeModal,
    title: modalState.title,
    message: modalState.message,
    actions: modalState.actions,
    type: modalState.type,
  };

  return { showAlert, showConfirm, showActionSheet, modalProps };
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  overlayCenter: {
    justifyContent: 'center',
  },
  sheet: {
    width: '100%',
    maxWidth: 500,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'web' ? 34 : 20,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: 16,
  },
  sheetTitle: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.textLight,
    textAlign: 'center',
    marginBottom: 16,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sheetActions: {
    backgroundColor: Colors.background,
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 10,
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 14,
  },
  sheetItemPressed: {
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  sheetItemBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  sheetIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sheetItemText: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Inter_500Medium',
    color: Colors.text,
  },
  sheetItemTextDestructive: {
    color: Colors.error,
  },
  cancelBtn: {
    backgroundColor: Colors.background,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.textLight,
  },
  pressed: {
    opacity: 0.85,
  },
  alertCard: {
    width: '90%',
    maxWidth: 380,
    backgroundColor: Colors.surface,
    borderRadius: 20,
    paddingTop: 28,
    paddingHorizontal: 24,
    paddingBottom: 18,
    ...(Platform.OS !== 'web'
      ? { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.2, shadowRadius: 24, elevation: 12 }
      : {}),
  },
  alertTitle: {
    fontSize: 19,
    fontFamily: 'Inter_700Bold',
    color: Colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  alertMessage: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 22,
  },
  alertActions: {
    flexDirection: 'row',
    gap: 10,
  },
  alertBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: Colors.background,
    alignItems: 'center',
  },
  alertBtnDestructive: {
    backgroundColor: 'rgba(255,59,48,0.1)',
  },
  alertBtnPrimary: {
    backgroundColor: Colors.primary,
  },
  alertBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text,
  },
  alertBtnTextDestructive: {
    color: Colors.error,
  },
  alertBtnTextPrimary: {
    color: Colors.secondary,
  },
});
