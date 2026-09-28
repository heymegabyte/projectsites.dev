import React from 'react';

interface FilePreviewProps {
  files: File[];
  imageDataList: string[];
  onRemove: (index: number) => void;
}

const FilePreview: React.FC<FilePreviewProps> = ({ files, imageDataList, onRemove }) => {
  if (!files || files.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-row overflow-x-auto mx-2 -mt-1 p-2 bg-bolt-elements-background-depth-3 border border-b-none border-bolt-elements-borderColor rounded-lg rounded-b-none">
      {files.map((file, index) => (
        <div key={file.name + file.size} className="mr-2 relative">
          {imageDataList[index] && (
            <div className="relative">
              <img src={imageDataList[index]} alt={file.name} className="max-h-20 rounded-lg" />
              <button
                type="button"
                onClick={() => onRemove(index)}
                aria-label={`Remove ${file.name}`}
                title={`Remove ${file.name}`}
                className="absolute -top-1 -right-1 z-10 bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor text-bolt-elements-textSecondary rounded-full w-5 h-5 shadow-md hover:bg-bolt-elements-button-danger-background hover:text-bolt-elements-button-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent transition-colors flex items-center justify-center"
              >
                <div className="i-ph:x w-3 h-3" />
              </button>
              <div className="absolute bottom-0 w-full h-5 flex items-center px-2 rounded-b-lg text-bolt-elements-textTertiary font-thin text-xs bg-bolt-elements-background-depth-2">
                <span className="truncate">{file.name}</span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default FilePreview;
